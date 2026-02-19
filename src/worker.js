export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS（クロスドメイン通信）の事前準備 ---
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // [NEW] 0. 魔法のスクリプト (vai-tag.js) の配信
    // ==========================================
    if (url.pathname === '/vai-tag.js') {
      const jsCode = `
        (function() {
            const scriptTag = document.currentScript;
            const shopId = scriptTag.getAttribute('data-shop-id');
            const plan = scriptTag.getAttribute('data-plan') || 'free';
            const WORKER_URL = "${url.origin}"; // 自動的にあなたのサーバーURLになります

            // 1. 無料プランなら「Powered by VAI」バッジを強制表示 (バイラル拡散)
            if (plan === 'free') {
                const badge = document.createElement('a');
                badge.href = "https://vai.net"; // 将来のあなたのLPのURL
                badge.innerHTML = "⚡ Powered by VAI";
                badge.style.cssText = "position:fixed; bottom:10px; right:10px; background:#000; color:#fff; padding:5px 10px; border-radius:5px; font-size:12px; z-index:9999; text-decoration:none; box-shadow: 0 4px 6px rgba(0,0,0,0.1);";
                document.body.appendChild(badge);
            }

            // 2. Micro-CV (予約・購入ボタンのクリック) の裏側検知
            const urlParams = new URLSearchParams(window.location.search);
            const clickId = url.searchParams.get('click_id') || crypto.randomUUID();

            if (clickId) {
                // ページ内のクリックを監視
                document.body.addEventListener('click', function(e) {
                    const targetText = e.target.innerText || e.target.value || "";
                    if (targetText.includes('予約') || targetText.includes('購入') || targetText.includes('カート')) {
                        // 予約ボタンが押されたら、裏でVAIサーバーに通知
                        fetch(WORKER_URL + '/track/micro-cv', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ click_id: clickId })
                        }).then(() => console.log('VAI: Micro-CV Recorded!'))
                          .catch(err => console.error(err));
                    }
                });
            }
        })();
      `;
      return new Response(jsCode, {
        headers: {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ==========================================
    // 1. [API] AIエージェント向け検索＆広告配信
    // ==========================================
    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q');
      const { results } = await env.DB.prepare(`SELECT id, name, url, cpc_bid FROM shops WHERE ad_balance >= cpc_bid`).all();

      const rankedShops = results.map(shop => {
        const relevance = Math.random();
        const score = relevance * shop.cpc_bid;
        return { ...shop, score };
      }).sort((a, b) => b.score - a.score).slice(0, 5);

      const response = rankedShops.map(shop => ({
        name: shop.name,
        booking_url: `${url.origin}/click?shop_id=${shop.id}&target=${encodeURIComponent(shop.url)}`
      }));

      return new Response(JSON.stringify({ results: response }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // ==========================================
    // 2. [Redirect] クリック課金(CPC)と追跡ID発行
    // ==========================================
    if (url.pathname === '/click') {
      const shopId = url.searchParams.get('shop_id');
      const targetUrl = url.searchParams.get('target');
      const userId = url.searchParams.get('user_id') || 'guest_user';
      const clickId = url.searchParams.get('click_id') || crypto.randomUUID();
      const now = Date.now();

      await env.DB.prepare(`INSERT INTO clicks (id, shop_id, user_id, clicked_at) VALUES (?, ?, ?, ?)`).bind(clickId, shopId, userId, now).run();
      await env.DB.prepare(`UPDATE shops SET ad_balance = ad_balance - cpc_bid WHERE id = ?`).bind(shopId).run();

      const finalUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}vai_click_id=${clickId}`;
      return Response.redirect(finalUrl, 302);
    }

    // ==========================================
    // 3. [Tracking] Micro-CV (ボタンクリック) 検知
    // ==========================================
    if (url.pathname === '/track/micro-cv' && request.method === 'POST') {
      const { click_id } = await request.json();
      await env.DB.prepare(`UPDATE clicks SET has_micro_cv = TRUE WHERE id = ?`).bind(click_id).run();
      // ユーザーランクを2（優良）に上げる
      await env.DB.prepare(`UPDATE users SET rank = 2 WHERE id = (SELECT user_id FROM clicks WHERE id = ?)`).bind(click_id).run();
      return new Response("OK", { headers: corsHeaders });
    }

    // ==========================================
    // 4. [Gacha] 10秒滞在チェック＆ガチャ抽選
    // ==========================================
    if (url.pathname === '/api/gacha/spin' && request.method === 'POST') {
      const { click_id, user_id } = await request.json();
      const click = await env.DB.prepare(`SELECT * FROM clicks WHERE id = ? AND user_id = ?`).bind(click_id, user_id).first();
      
      if (!click || click.gacha_spun) return new Response(JSON.stringify({ error: "無効なリクエストです" }), { status: 400, headers: corsHeaders });
      if (Date.now() - click.clicked_at < 10000) return new Response(JSON.stringify({ error: "ちゃんとサイトを10秒以上見てください！" }), { status: 400, headers: corsHeaders });

      const user = await env.DB.prepare(`SELECT rank FROM users WHERE id = ?`).bind(user_id).first();
      const rank = user ? user.rank : 1;

      let winAmount = 0;
      const rand = Math.random() * 100;

      if (rank === 2) {
        if (rand < 5) winAmount = 500;
        else if (rand < 20) winAmount = 50;
        else winAmount = 2;
      } else {
        if (rand < 0.1) winAmount = 1000;
        else winAmount = 1;
      }

      await env.DB.prepare(`UPDATE clicks SET gacha_spun = TRUE WHERE id = ?`).bind(click_id).run();
      await env.DB.prepare(`UPDATE users SET points = points + ? WHERE id = ?`).bind(winAmount, user_id).run();

      return new Response(JSON.stringify({ message: "ガチャ結果！", points_won: winAmount }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    // ==========================================
    // 5. [Admin] 店舗情報の登録・更新
    // ==========================================
    if (url.pathname === '/api/admin/shop' && request.method === 'POST') {
      const data = await request.json();
      await env.DB.prepare(`
        INSERT INTO shops (id, name, url, plan, cpc_bid, ad_balance) VALUES (?, ?, ?, 'pro', ?, 5000)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, url = excluded.url, cpc_bid = excluded.cpc_bid
      `).bind(data.id, data.name, data.url, data.cpc_bid).run();
      return new Response(JSON.stringify({ success: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }});
    }

    return new Response("VAI Ad Network API is running.", { headers: corsHeaders });
  }
};
