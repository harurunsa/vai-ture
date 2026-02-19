export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    // ==========================================
    // 🔑 【重要】ここにLINEのチャネルアクセストークンを貼る
    // ==========================================
    const LINE_TOKEN = "f511a318334b2c21d982d66a2085618e";

    // ==========================================
    // 0. 魔法のスクリプト (vai-tag.js)
    // ==========================================
    if (url.pathname === '/vai-tag.js') {
      const jsCode = `
        (function() {
            const scriptTag = document.currentScript;
            const shopId = scriptTag.getAttribute('data-shop-id');
            const WORKER_URL = "${url.origin}";
            const clickId = new URLSearchParams(window.location.search).get('vai_click_id');

            if (clickId) {
                document.body.addEventListener('click', function(e) {
                    const targetText = e.target.innerText || e.target.value || "";
                    if (targetText.includes('予約') || targetText.includes('購入') || targetText.includes('カート')) {
                        fetch(WORKER_URL + '/track/micro-cv', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ click_id: clickId })
                        }).catch(err => console.error(err));
                    }
                });
            }
        })();
      `;
      return new Response(jsCode, { headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' } });
    }

    // ==========================================
    // 1~6. API, Redirect, Micro-CV, Gacha, Admin, Payment (既存処理)
    // ==========================================
    if (url.pathname === '/click') {
      const shopId = url.searchParams.get('shop_id');
      const targetUrl = url.searchParams.get('target');
      const userId = url.searchParams.get('user_id') || 'guest';
      const clickId = crypto.randomUUID();
      
      await env.DB.prepare(`INSERT INTO clicks (id, shop_id, user_id, clicked_at) VALUES (?, ?, ?, ?)`).bind(clickId, shopId, userId, Date.now()).run();
      await env.DB.prepare(`UPDATE shops SET ad_balance = ad_balance - cpc_bid WHERE id = ?`).bind(shopId).run();
      return Response.redirect(`${targetUrl}${targetUrl.includes('?') ? '&' : '?'}vai_click_id=${clickId}`, 302);
    }

    if (url.pathname === '/track/micro-cv' && request.method === 'POST') {
      const { click_id } = await request.json();
      await env.DB.prepare(`UPDATE clicks SET has_micro_cv = TRUE WHERE id = ?`).bind(click_id).run();
      await env.DB.prepare(`UPDATE users SET rank = 2 WHERE id = (SELECT user_id FROM clicks WHERE id = ?)`).bind(click_id).run();
      return new Response("OK", { headers: corsHeaders });
    }

    if (url.pathname === '/api/admin/shop' && request.method === 'POST') {
      const data = await request.json();
      await env.DB.prepare(`INSERT INTO shops (id, name, url, plan, cpc_bid, ad_balance) VALUES (?, ?, ?, 'pro', ?, 0) ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, cpc_bid = excluded.cpc_bid`).bind(data.id, data.name, data.url, data.cpc_bid).run();
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    if (url.pathname === '/webhook/lemonsqueezy' && request.method === 'POST') {
      try {
        const payload = await request.json();
        if (payload.meta?.event_name === 'order_created') {
          const shopId = payload.meta.custom_data?.shop_id; 
          const amount = payload.data?.attributes?.total;
          if (shopId && amount > 0) await env.DB.prepare(`UPDATE shops SET ad_balance = ad_balance + ? WHERE id = ?`).bind(amount, shopId).run();
        }
        return new Response("Webhook OK");
      } catch (e) { return new Response("Error", { status: 500 }); }
    }

    // ==========================================
    // 7. [NEW] LINE Bot Webhook (LINEからのメッセージ対応)
    // ==========================================
    if (url.pathname === '/webhook/line' && request.method === 'POST') {
      try {
        const body = await request.json();

        for (const event of body.events) {
          if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text;
            const lineUserId = event.source.userId; // LINEの固有IDをDBのユーザーIDとして使う
            let replyText = "";

            // もしユーザーが「ガチャ」と打ってきたら
            if (text === 'ガチャ') {
              // このユーザーの最新のクリック履歴を探す
              const click = await env.DB.prepare(`
                SELECT * FROM clicks WHERE user_id = ? AND gacha_spun = FALSE ORDER BY clicked_at DESC LIMIT 1
              `).bind(lineUserId).first();

              if (!click) {
                replyText = "回せるガチャがありません😢\nまずは「焼肉」などのお店を検索して、リンクを見てきてね！";
              } else if (Date.now() - click.clicked_at < 10000) {
                replyText = "まだ10秒経っていません！⏳\nお店のサイトをしっかり見てから、もう一度「ガチャ」と送ってね👀";
              } else {
                // ガチャ実行！
                const user = await env.DB.prepare(`SELECT rank FROM users WHERE id = ?`).bind(lineUserId).first();
                const rank = user ? user.rank : 1;
                let winAmount = 0;
                const rand = Math.random() * 100;

                if (rank === 2) {
                  if (rand < 5) winAmount = 500; else if (rand < 20) winAmount = 50; else winAmount = 2;
                } else {
                  if (rand < 0.1) winAmount = 1000; else winAmount = 1;
                }

                // 履歴を更新し、ポイントを付与（新規ユーザーなら作成）
                await env.DB.prepare(`UPDATE clicks SET gacha_spun = TRUE WHERE id = ?`).bind(click.id).run();
                await env.DB.prepare(`
                  INSERT INTO users (id, line_id, points, rank) VALUES (?, ?, ?, 1)
                  ON CONFLICT(id) DO UPDATE SET points = points + ?
                `).bind(lineUserId, lineUserId, winAmount, winAmount).run();

                replyText = `🎉 ガチャ結果発表 🎉\n\n見事【 ${winAmount}円分 】のポイントGET！💎\n\n※予約ボタンを押した「神客」は当たりやすくなります！`;
              }
            } 
            // 「ガチャ」以外の言葉（お店の検索）の場合
            else {
              const { results } = await env.DB.prepare(`
                SELECT id, name, url FROM shops WHERE ad_balance >= cpc_bid AND name LIKE ? LIMIT 3
              `).bind(`%${text}%`).all();

              if (results.length === 0) {
                replyText = `「${text}」のお店は見つかりませんでした😢\n「焼肉」などで検索してみてね！`;
              } else {
                replyText = `✨ おすすめのお店が見つかりました！\n`;
                for (const shop of results) {
                   const bookingUrl = `${url.origin}/click?shop_id=${shop.id}&target=${encodeURIComponent(shop.url)}&user_id=${lineUserId}`;
                   replyText += `\n🥩 ${shop.name}\n${bookingUrl}\n`;
                }
                replyText += `\n👆ここからお店のサイトを【10秒】見てから、この画面に戻ってきて「ガチャ」とメッセージを送ってね🎁`;
              }
            }

            // LINEのサーバーに返事を送る
            await fetch('https://api.line.me/v2/bot/message/reply', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_TOKEN}`
              },
              body: JSON.stringify({
                replyToken: event.replyToken,
                messages: [{ type: 'text', text: replyText }]
              })
            });
          }
        }
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error(error);
        return new Response("Error", { status: 500 });
      }
    }

    return new Response("VAI Ad Network API is running.", { headers: corsHeaders });
  }
};
