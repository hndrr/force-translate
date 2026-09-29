# 開発・配布用ファイルの作成

## GitHub Actions

ブランチへのpush・Pull Request・手動実行で、`Package extension`ワークフローが次を実行します。

1. `npm ci`で固定バージョンの開発用依存関係をインストール
2. パッケージ処理のテスト
3. TypeScriptの型チェックとビルド
4. 配布対象ファイルの参照先・JavaScript構文・ZIP内容を検証
5. 配布用ZIPと確認レポートをActionsの成果物に保存（30日間）

GitHubの **Actions → Package extension → 成功した実行 → Artifacts** から
`force-translate-<version>.zip`をダウンロードできます。
ZIPをそのまま保存する設定なので、二重にZIPを展開する必要はありません。
`packaging-report`にはチェックサムと提出前の確認リストをまとめています。

手動実行は、ワークフローがデフォルトブランチに入った後に **Run workflow** から行えます。
成果物の取得にはGitHubへのログインとリポジトリへの読み取り権限が必要です。
長期保存する配布用ZIPは、`main`へのpushでGitHub Releasesに自動保存します。

## GitHub Releasesへの自動保存

`main`へのpush（Pull Requestのマージを含む）で、`Release extension`ワークフローが動きます。
既存のバージョンタグを調べ、次の番号を自動採番します。テスト・ビルド・パッケージ検証後に`v<version>`のタグとGitHub Releaseを自動作成します。
タグはビルドしたコミットに付くため、処理中に次のpushがあっても別のソースを指すことはありません。
ReleaseにはZIP・SHA-256チェックサム・提出前の確認リストが添付されます。
添付ファイルにはActions成果物の30日間の保存期限は適用されません。

普段の作業は変更を`main`へpushまたはマージするだけです。バージョンの手動更新・タグ操作・Release作成は不要です。
バージョンタグがまだない初回は`manifest.json`の`0.5.0`を使い、その後は`0.5.1 → 0.5.2 → …`と自動で増えます。
既存タグは数値順で比較し、Release作成前に処理が失敗してタグだけ残った番号も予約済みとして扱います。

採番した番号はActions内の`manifest.json`に反映してからビルドするため、タグ・ZIP名・ZIP内のバージョンが一致します。
リポジトリへのバージョン更新コミットは作成しません。ソース側の`manifest.json`は初回番号・最低バージョンの指定として残ります。
メジャー・マイナーバージョンを意図的に上げるときだけ、既存タグより大きい番号を`manifest.json`に指定できます。

完了後はリポジトリの **Releases → Force Translate v0.5.0 → Assets** からZIPを取得できます。
同じコミットを再実行した場合、公開済みなら成功扱いでスキップし、タグだけが残っていれば同じ番号で公開を再開します。
Release処理は同時実行せず、採番の衝突を防ぎます。短時間に複数のpushが続く場合は、GitHub Actionsの待機中の実行が最新のpushに置き換わることがあります。
番号が不正な場合、APIの確認に失敗した場合、テスト・ビルドに失敗した場合は公開しません。

認証にはGitHub Actionsの標準トークンを使用します。追加のシークレット登録は不要です。
ストアへの提出は別途行います。

## ローカル実行

Node.js 22以上とnpmを使用します。

```sh
npm ci
npm run package
```

生成物は次のとおりです。

- `dist/force-translate-<version>.zip`: 配布用ZIP。`manifest.json`が直下に入ります。
- `dist/force-translate-<version>.zip.sha256`: ZIPのSHA-256チェックサム。
- `dist/extension/`: Chromeで読み込んで動作確認できるフォルダ。
- `dist/release-checklist.md`: 自動確認の結果と公開前に残っている作業。

ローカルと`Package extension`の検証用ZIPは、ソース側の`manifest.json`の番号を使用します。
自動採番は`Release extension`で行うため、公開用ZIPはGitHub Releasesから取得してください。
ZIPには実行用ファイルだけを含め、TypeScriptソース、開発用依存関係、文書、秘密鍵は含めません。
同じ入力から同じ内容のZIPを生成します。

開発中は`npm run check`で型チェック、`npm run build`でJavaScriptの生成、`npm test`でパッケージ処理のテストを実行できます。
`build.sh`も`npm run build`を呼び出します。

## 公開用の準備

拡張アイコンは`icons/`に用意済みです。ストア掲載画像は未用意のため、ストア提出には追加の準備が必要です。

- 拡張アイコンは16・32・48・128pxの透過PNGを`manifest.json`の`icons`に登録しています。画像は自動でZIPに入り、寸法も検証します。
- ツールバーには`action.default_icon`で16・32pxのアイコンを指定しています。
- 原本は`assets/icon-master.png`、画像生成のプロンプトは`assets/icon-prompt.md`に保存しています。これらは配布用ZIPに含めません。
- スクリーンショットとプロモーション画像はストア管理画面に提出します。
- ストア説明と権限理由の下書きは`store/listing.ja.md`、プライバシーポリシーの下書きは`store/privacy-policy.ja.md`にあります。
- Chromeでの実動作を確認してから、開発者アカウントでアップロード・審査申請します。

実行用ファイルを増やす場合は、`scripts/package-lib.mjs`の配布対象にも追加してください。
アイコン以外の新しい参照先が未登録なら、パッケージ作成をエラーで停止します。

参考: [Chrome拡張の提出準備](https://developer.chrome.com/docs/webstore/prepare)、[画像の要件](https://developer.chrome.com/docs/webstore/images)、[Actionsの成果物](https://github.com/actions/upload-artifact)、[GitHub Releaseの作成](https://cli.github.com/manual/gh_release_create)。
