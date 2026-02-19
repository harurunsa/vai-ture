export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    const LINE_TOKEN = env.LINE_TOKEN; // 🔐 シークレットから取得

    // 0. 魔法のスクリプト
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
                            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ click_id: clickId })
                        }).catch(console.error);
                    }
                });
            }
        })();
      `;
      return new Response(jsCode, { headers: { 'Content-Type': 'application/javascript', 'Access-Control-Allow-Origin': '*' } });
    }

    // 1. API 検索
    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q');
      const { results } = await env.DB.prepare(`SELECT id, name, url, cpc_bid FROM shops WHERE ad_balance >= cpc_bid AND url != ''`).all();
      const rankedShops = results.map(shop => ({ ...shop, score: Math.random() * shop.cpc_bid })).sort((a, b) => b.score - a.score).slice(0, 5);
      const response = rankedShops.map(shop => ({
        name: shop.name, booking_url: `${url.origin}/click?shop_id=${shop.id}&target=${encodeURIComponent(shop.url)}`
      }));
      return new Response(JSON.stringify({ results: response }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // 2. Click Redirect
    if (url.pathname === '/click') {
      const shopId = url.searchParams.get('shop_id');
      const targetUrl = url.searchParams.get('target');
      const userId = url.searchParams.get('user_id') || 'guest';
      const clickId = url.searchParams.get('click_id') || crypto.randomUUID();
      await env.DB.prepare(`INSERT INTO clicks (id, shop_id, user_id, clicked_at) VALUES (?, ?, ?, ?)`).bind(clickId, shopId, userId, Date.now()).run();
      await env.DB.prepare(`UPDATE shops SET ad_balance = ad_balance - cpc_bid WHERE id = ?`).bind(shopId).run();
      return Response.redirect(`${targetUrl}${targetUrl.includes('?') ? '&' : '?'}vai_click_id=${clickId}`, 302);
    }

    // 3. Micro-CV
    if (url.pathname === '/track/micro-cv' && request.method === 'POST') {
      const { click_id } = await request.json();
      await env.DB.prepare(`UPDATE clicks SET has_micro_cv = TRUE WHERE id = ?`).bind(click_id).run();
      await env.DB.prepare(`UPDATE users SET rank = 2 WHERE id = (SELECT user_id FROM clicks WHERE id = ?)`).bind(click_id).run();
      return new Response("OK", { headers: corsHeaders });
    }

    // 4. Gacha
    if (url.pathname === '/api/gacha/spin' && request.method === 'POST') {
      const { click_id, user_id } = await request.json();
      const click = await env.DB.prepare(`SELECT * FROM clicks WHERE id = ? AND user_id = ?`).bind(click_id, user_id).first();
      if (!click || click.gacha_spun) return new Response(JSON.stringify({ error: "無効なリクエストです" }), { status: 400, headers: corsHeaders });
      if (Date.now() - click.clicked_at < 10000) return new Response(JSON.stringify({ error: "10秒以上見てください！" }), { status: 400, headers: corsHeaders });

      const user = await env.DB.prepare(`SELECT rank FROM users WHERE id = ?`).bind(user_id).first();
      const rank = user ? user.rank : 1;
      let winAmount = rank === 2 ? (Math.random()*100 < 5 ? 500 : Math.random()*100 < 20 ? 50 : 2) : (Math.random()*100 < 0.1 ? 1000 : 1);

      await env.DB.prepare(`UPDATE clicks SET gacha_spun = TRUE WHERE id = ?`).bind(click_id).run();
      await env.DB.prepare(`UPDATE users SET points = points + ? WHERE id = ?`).bind(winAmount, user_id).run();
      return new Response(JSON.stringify({ message: "ガチャ結果！", points_won: winAmount }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // 5. Admin マイページ用API (GET: 情報取得, POST: 新規作成・更新)
    if (url.pathname === '/api/admin/shop') {
      if (request.method === 'GET') {
        const shopId = url.searchParams.get('id');
        const shop = await env.DB.prepare(`SELECT * FROM shops WHERE id = ?`).bind(shopId).first();
        if (!shop) return new Response(JSON.stringify({ error: "店舗が見つかりません" }), { status: 404, headers: corsHeaders });
        return new Response(JSON.stringify(shop), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
      }
      
      if (request.method === 'POST') {
        const data = await request.json();
        
        if (!data.id) {
          // [新規作成] 推測不可能なIDを生成し、空の状態でデータベースを作成（すぐチャージ可能にするため）
          const newShopId = crypto.randomUUID().replace(/-/g, ''); // ハイフン無しの32文字の安全なID
          await env.DB.prepare(`INSERT INTO shops (id, name, url, plan, cpc_bid, ad_balance) VALUES (?, '未設定', '', 'pro', 50, 0)`).bind(newShopId).run();
          return new Response(JSON.stringify({ success: true, id: newShopId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
        } else {
          // [更新] 既存店舗の情報をアップデート
          await env.DB.prepare(`UPDATE shops SET name = ?, url = ?, cpc_bid = ? WHERE id = ?`).bind(data.name, data.url, data.cpc_bid, data.id).run();
          return new Response(JSON.stringify({ success: true, id: data.id }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
        }
      }
    }

    // 6. Payment Webhook
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

    // 7. LINE Bot Webhook
    if (url.pathname === '/webhook/line' && request.method === 'POST') {
      try {
        const body = await request.json();
        for (const event of body.events) {
          if (event.type === 'message' && event.message.type === 'text') {
            const text = event.message.text;
            const lineUserId = event.source.userId;
            let replyText = "";

            if (text === 'ガチャ') {
              const click = await env.DB.prepare(`SELECT * FROM clicks WHERE user_id = ? AND gacha_spun = FALSE ORDER BY clicked_at DESC LIMIT 1`).bind(lineUserId).first();
              if (!click) replyText = "回せるガチャがありません😢\nお店を検索してリンクを見てきてね！";
              else if (Date.now() - click.clicked_at < 10000) replyText = "まだ10秒経っていません！⏳";
              else {
                const user = await env.DB.prepare(`SELECT rank FROM users WHERE id = ?`).bind(lineUserId).first();
                const rank = user ? user.rank : 1;
                let winAmount = rank === 2 ? (Math.random()*100 < 5 ? 500 : Math.random()*100 < 20 ? 50 : 2) : (Math.random()*100 < 0.1 ? 1000 : 1);
                await env.DB.prepare(`UPDATE clicks SET gacha_spun = TRUE WHERE id = ?`).bind(click.id).run();
                await env.DB.prepare(`INSERT INTO users (id, line_id, points, rank) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET points = points + ?`).bind(lineUserId, lineUserId, winAmount, winAmount).run();
                replyText = `🎉 ガチャ結果発表 🎉\n\n見事【 ${winAmount}円分 】のポイントGET！💎\n\n※予約ボタンを押した「神客」は当たりやすくなります！`;
              }
            } else {
              const { results } = await env.DB.prepare(`SELECT id, name, url FROM shops WHERE ad_balance >= cpc_bid AND url != '' AND name LIKE ? LIMIT 3`).bind(`%${text}%`).all();
              if (results.length === 0) replyText = `「${text}」は見つかりませんでした😢\n「焼肉」等で検索してみてね！`;
              else {
                replyText = `✨ おすすめのお店が見つかりました！\n`;
                for (const shop of results) {
                   replyText += `\n🥩 ${shop.name}\n${url.origin}/click?shop_id=${shop.id}&target=${encodeURIComponent(shop.url)}&user_id=${lineUserId}\n`;
                }
                replyText += `\n👆ここからサイトを【10秒】見てから戻ってきて「ガチャ」と送ってね🎁`;
              }
            }
            await fetch('https://api.line.me/v2/bot/message/reply', {
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${LINE_TOKEN}` },
              body: JSON.stringify({ replyToken: event.replyToken, messages: [{ type: 'text', text: replyText }] })
            });
          }
        }
        return new Response("OK", { status: 200 });
      } catch (e) { return new Response("Error", { status: 500 }); }
    }

    return new Response("VAI Ad Network API is running.", { headers: corsHeaders });
  }
};
