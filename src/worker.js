export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- CORS（クロスドメイン通信）の事前準備 ---
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*', // 本番ではドメインを指定します
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    };

    // ブラウザからの事前確認（OPTIONSリクエスト）にOKを返す
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ==========================================
    // 1. [API] AIエージェント向け検索＆広告配信
    // ==========================================
    if (url.pathname === '/api/search') {
      const query = url.searchParams.get('q');
      
      // 残高(ad_balance)が入札単価(cpc_bid)以上ある店舗だけを取得
      const { results } = await env.DB.prepare(`
        SELECT id, name, url, cpc_bid 
        FROM shops 
        WHERE ad_balance >= cpc_bid
      `).all();

      // 簡易オークション: 関連度(今はランダムで代用) × 単価 でスコア化
      const rankedShops = results.map(shop => {
        const relevance = Math.random();
        const score = relevance * shop.cpc_bid;
        return { ...shop, score };
      }).sort((a, b) => b.score - a.score).slice(0, 5); // 上位5件

      // AIに渡すレスポンス (クリック計測用URLに変換して渡す)
      const response = rankedShops.map(shop => ({
        name: shop.name,
        booking_url: `${url.origin}/click?shop_id=${shop.id}&target=${encodeURIComponent(shop.url)}`
      }));

      return new Response(JSON.stringify({ results: response }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ==========================================
    // 2. [Redirect] クリック課金(CPC)と追跡ID発行
    // ==========================================
    if (url.pathname === '/click') {
      const shopId = url.searchParams.get('shop_id');
      const targetUrl = url.searchParams.get('target');
      const userId = url.searchParams.get('user_id') || 'guest';
      const clickId = crypto.randomUUID();
      const now = Date.now();

      // ログ保存
      await env.DB.prepare(`
        INSERT INTO clicks (id, shop_id, user_id, clicked_at) VALUES (?, ?, ?, ?)
      `).bind(clickId, shopId, userId, now).run();

      // 店舗の残高(ad_balance)引き落とし
      await env.DB.prepare(`
        UPDATE shops SET ad_balance = ad_balance - cpc_bid WHERE id = ?
      `).bind(shopId).run();

      // Micro-CV検知用にURLにパラメーターを付与してリダイレクト
      const finalUrl = `${targetUrl}${targetUrl.includes('?') ? '&' : '?'}vai_click_id=${clickId}`;
      return Response.redirect(finalUrl, 302);
    }

    // ==========================================
    // 3. [Tracking] Micro-CV (ボタンクリック) 検知
    // ==========================================
    if (url.pathname === '/track/micro-cv' && request.method === 'POST') {
      const { click_id } = await request.json();
      
      await env.DB.prepare(`UPDATE clicks SET has_micro_cv = TRUE WHERE id = ?`).bind(click_id).run();
      await env.DB.prepare(`
        UPDATE users SET rank = 2 
        WHERE id = (SELECT user_id FROM clicks WHERE id = ?)
      `).bind(click_id).run();

      return new Response("OK", { headers: corsHeaders });
    }

    // ==========================================
    // 4. [Gacha] 10秒滞在チェック＆ガチャ抽選
    // ==========================================
    if (url.pathname === '/api/gacha/spin' && request.method === 'POST') {
      const { click_id, user_id } = await request.json();

      const click = await env.DB.prepare(`SELECT * FROM clicks WHERE id = ? AND user_id = ?`).bind(click_id, user_id).first();
      
      if (!click || click.gacha_spun) {
        return new Response(JSON.stringify({ error: "無効なリクエストです" }), { status: 400, headers: corsHeaders });
      }

      // 10秒(10000ms)滞在フィルター
      if (Date.now() - click.clicked_at < 10000) {
        return new Response(JSON.stringify({ error: "ちゃんとサイトを10秒以上見てください！" }), { status: 400, headers: corsHeaders });
      }

      const user = await env.DB.prepare(`SELECT rank FROM users WHERE id = ?`).bind(user_id).first();
      const rank = user ? user.rank : 1;

      // ガチャ確率計算 (絶対に赤字にならない設定)
      let winAmount = 0;
      const rand = Math.random() * 100;

      if (rank === 2) {
        if (rand < 5) winAmount = 500; // 5%で500円
        else if (rand < 20) winAmount = 50; // 15%で50円
        else winAmount = 2; // 外れても2円
      } else {
        if (rand < 0.1) winAmount = 1000; // 0.1%の夢
        else winAmount = 1; // 基本1円
      }

      // 結果を保存
      await env.DB.prepare(`UPDATE clicks SET gacha_spun = TRUE WHERE id = ?`).bind(click_id).run();
      await env.DB.prepare(`UPDATE users SET points = points + ? WHERE id = ?`).bind(winAmount, user_id).run();

      return new Response(JSON.stringify({ message: "ガチャ結果！", points_won: winAmount }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ==========================================
    // 5. [Admin] 店舗情報の登録・更新
    // ==========================================
    if (url.pathname === '/api/admin/shop' && request.method === 'POST') {
      const data = await request.json();
      
      // D1のUPSERT機能 (新規登録または上書き更新)
      // テスト用に ad_balance に 5000円 をチャージしています
      await env.DB.prepare(`
        INSERT INTO shops (id, name, url, plan, cpc_bid, ad_balance) 
        VALUES (?, ?, ?, 'pro', ?, 5000)
        ON CONFLICT(id) DO UPDATE SET 
          name = excluded.name, 
          url = excluded.url, 
          cpc_bid = excluded.cpc_bid
      `).bind(data.id, data.name, data.url, data.cpc_bid).run();

      return new Response(JSON.stringify({ success: true }), { 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response("VAI Ad Network API is running.", { headers: corsHeaders });
  }
};
