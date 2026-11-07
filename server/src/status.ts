// Honest implementation status shown on the judge page. Update with the code.
export const IMPLEMENTATION_STATUS = [
  { area: 'Channel3 data collection (search, per-store offers, 30-day history, tracking)', state: 'working', note: 'Daily job on the collector machine; Cloud Run serves a snapshot of its database', area_ja: 'Channel3 のデータ収集（検索、店ごとの出品、30日履歴、追跡）', note_ja: '収集用のマシンで毎日のジョブ。Cloud Run はそのデータベースの写しを配信' },
  { area: 'Claim contracts (4 claim types), frozen terms + SHA-256 hash', state: 'working', note: '', area_ja: '主張契約（4種類）、条件の固定と SHA-256 ハッシュ', note_ja: '' },
  { area: 'Rule-based judging and PayPal Sandbox partial refunds', state: 'working', note: 'Live windows end 7–14 days after purchase; early settlement for final lowest-price misses', area_ja: 'ルールによる判定と PayPal Sandbox の部分返金', note_ja: 'ライブの判定期間は購入から7〜14日（最安値の確定外れは早期確定）' },
  { area: 'Buyer agent + AP2 open/closed mandates + PayPal Agent Toolkit', state: 'working', note: 'Multi-store negotiation, cryptographic AP2 mandate verification, Toolkit create_order / pay_order', area_ja: '買い手エージェント＋AP2 委任署名検証＋PayPal Agent Toolkit', note_ja: '複数店舗との交渉、AP2 委任チェーンの署名検証、Toolkit での注文・決済' },
  { area: 'Past-day replay & 14-day fast-forward (bought or waited)', state: 'working', note: 'Real Sandbox order at day D price; leak-free drop14-replay models (causal as-of D + 5-fold out-of-group)', area_ja: '過去の日の再現と14日早送り（購入・待機の双方）', note_ja: '再現日 D の実価格で Sandbox 決済し、その後の実価格で判定。未来情報リークなしのモデルを使用' },
  { area: 'Hash-chained public ledger', state: 'working', note: '', area_ja: 'ハッシュで連鎖した公開台帳', note_ja: '' },
  { area: 'Failure-probability models (price drop 14d, lowest-price break 7d, leak-free replay)', state: 'working', note: 'Logistic regression on ≤30 days of history; held-out & causal as-of calibration shown', area_ja: '外れる確率のモデル（14日の値下がり、7日の最安値崩れ、再現用リークなしモデル）', note_ja: '30日以内の履歴でロジスティック回帰。学習外データと時系列モデルの検証結果を表示' },
  { area: 'Store accuracy (Beta prior) and agent ranking with reasons', state: 'working', note: '', area_ja: '店の正確さ（ベータ事前分布）と理由付きの順位付け', note_ja: '' },
  { area: 'Replay of real price history with hypothetical stakes', state: 'working', note: 'Stakes are hypothetical; stores are anonymised', area_ja: '実際の価格履歴のリプレイ（保証は仮定）', note_ja: '保証は仮定。店名は匿名化' },
  { area: 'Claim extraction and catalog audit (Gemini on Vertex AI)', state: 'working', note: 'LLM never sets numbers or verdicts', area_ja: '主張の抽出とカタログ監査（Vertex AI の Gemini）', note_ja: 'LLM は数値も判定も決めない' },
  { area: 'Vouch MCP server (search with stakes, contract status)', state: 'working', note: 'stdio; remote HTTP transport after deploy', area_ja: 'Vouch MCP サーバー（保証付きの検索、契約の状態）', note_ja: 'stdio。リモートの HTTP はデプロイ後' },
  { area: 'One PayPal seller account per store', state: 'working', note: '3 Sandbox Business seller accounts verified with distinct merchant IDs; orders and refunds run on the store’s assigned seller account', area_ja: '店ごとの PayPal の売り手アカウント', note_ja: '3つの Sandbox Business アカウント（異なる merchant id）で注文・部分返金を検証済み' },
  { area: 'PayPal webhooks', state: 'code ready', note: 'Not registered with PayPal yet', area_ja: 'PayPal の Webhook', note_ja: 'PayPal への登録はまだ' },
  { area: 'Cloud Run deployment', state: 'working', note: 'One service (API + web), password login; verified end to end: purchase, verdict, PayPal refund', area_ja: 'Cloud Run へのデプロイ', note_ja: '1つのサービス（API と画面）、パスワードのログイン。購入・判定・PayPal の返金まで通しで確認' },
  { area: 'Assumption', state: 'assumed', note: 'Real stores have not staked any claim; replays show what would happen if they had', area_ja: '仮定', note_ja: '実在の店は保証していない。リプレイは保証していたらどうなるかを示す' },
] as const;

