(function() {
    const scriptTag = document.currentScript;
    const shopId = scriptTag.getAttribute('data-shop-id');
    const plan = scriptTag.getAttribute('data-plan') || 'free';

    // 1. 無料プランなら「Powered by VAI」バッジを強制表示 (バイラル拡散)
    if (plan === 'free') {
        const badge = document.createElement('a');
        badge.href = "https://vai.net";
        badge.innerHTML = "⚡ Powered by VAI (AI Search Optimized)";
        badge.style.cssText = "position:fixed; bottom:10px; right:10px; background:#000; color:#fff; padding:5px 10px; border-radius:5px; font-size:12px; z-index:9999; text-decoration:none;";
        document.body.appendChild(badge);
    }

    // 2. Micro-CV (予約・購入ボタンのクリック) の裏側検知
    // URLのパラメータから VAIの click_id を取得
    const urlParams = new URLSearchParams(window.location.search);
    const clickId = urlParams.get('vai_click_id');

    if (clickId) {
        // ページ内の「予約」「購入」「カート」という文字を含むボタンを監視
        document.body.addEventListener('click', function(e) {
            const targetText = e.target.innerText || e.target.value || "";
            if (targetText.includes('予約') || targetText.includes('購入') || targetText.includes('カート')) {
                // VAIサーバーに「Micro-CV発生」を通知 (ユーザーランクUPのため)
                fetch(`https://api.vai.net/track/micro-cv`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ click_id: clickId })
                }).catch(err => console.error(err));
            }
        });
    }
})();
