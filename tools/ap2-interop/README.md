# AP2 相互検証（手元で実行する）

Vouch の TypeScript の AP2 実装（`server/src/ap2/`）が作る委任の連鎖を、AP2 の**公式 Python SDK**（google-agentic-commerce/AP2 @ e1ea56d）で検証する。

**結果（2026-10-28、手元の Mac）: 通った。** `checkout chain: signatures OK; violations: none` と `payment chain: signatures OK; violations: none`、終了コード 0（SDK は e1ea56d、Python は uv が用意したもの）。クラウドの開発環境では SDK のインストールが止められるので、手元で実行する。

```sh
# リポジトリのルートで
node tools/ap2-interop/make_fixtures.ts          # fixtures.json を作る（使い捨ての鍵）
cd tools/ap2-interop && uv sync                   # 公式 SDK を入れる（Python 3.11 以上）
uv run python verify_with_sdk.py                  # 署名・連鎖・条件を SDK で検証
```

成功すると `violations: none` が2行出て、終了コード 0。失敗したら、その出力のまま `server/src/ap2/sdjwt.ts` を直す（SDK の側に合わせる）。`fixtures.json` はコミットしない。
