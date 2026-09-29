# Force Translate

Chrome標準翻訳が効かないページ向けの、React-safeな強制翻訳拡張です。

## 使い方

Chromeツールバーの拡張アイコンを押すと、次の操作ができます。

- **このページを翻訳**
- **原文に戻す**
- **このサイトは自動翻訳** ON/OFF

自動翻訳をONにしたサイトでは、次回アクセス時やリロード後も自動で翻訳を開始します。自動翻訳ONのタブでは拡張アイコンに `A` バッジを表示します。

キーボードの `Alt + Shift + T` でも、現在ページの翻訳/原文を切り替えられます。

右クリックメニューからも操作できます。

## React-safe

`<html translate="no">` を指定しているサイトでも、その指定を無視して翻訳します。

DOMへ `<font>` や `<span>` を挿入せず、既存の `Text` nodeの `node.data` だけを書き換えます。

- 要素をwrapしない
- `replaceWith()`しない
- 翻訳用spanを差し込まない
- `translate="no"` / `.notranslate` は無視
- React/SPAが原文を書き戻したら、その新しい原文を再翻訳
- 自分自身の書き換えはMutationObserverで無視し、翻訳ループを防止
- ReactがTextNode自体を作り直した場合も追加Nodeだけ再走査
- cross-origin iframeは文字列だけtop frameへ送り、top frameで翻訳

## 初回モデル準備

Chrome内蔵Translator APIは、言語ペアのモデルが未取得の場合にユーザー操作を要求します。

ツールバーの **このページを翻訳** または **このサイトは自動翻訳** をクリックすると、必要なモデルを準備してからページ翻訳を開始します。モデル取得中は進捗バーを表示します。

## 翻訳対象外

- `script`, `style`, `noscript`, `template`
- `code`, `pre`, `kbd`, `samp`
- `textarea`, `select`, `option`
- `contenteditable`
- Canvas/WebGL/画像内文字
- closed Shadow DOM
- Chrome組み込みPDF viewer

## インストール

1. ZIPを展開
2. `chrome://extensions/`
3. デベロッパーモードをON
4. 「パッケージ化されていない拡張機能を読み込む」
5. 展開した `force-translate` フォルダを選択
6. 翻訳したいページのタブを再読み込み
7. ChromeツールバーのForce Translateアイコンを押して操作

Chrome 138+ デスクトップ版が対象です。
