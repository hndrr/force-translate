import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubClient } from "./github-release-api.mjs";

test("タグAPIに出ないdraftも一覧をページ送りして取得する", async () => {
  const draft = { tag_name: "v0.5.1", draft: true, target_commitish: "commit" };
  const paths = [];
  const { getRelease } = createGitHubClient({ apiUrl: "https://api.example.test", repo: "test/repo", token: "fake",
    async fetchImpl(url) {
      paths.push(url);
      if (url.includes("/releases/tags/")) return new Response("", { status: 404 });
      if (url.endsWith("page=1")) return Response.json(Array.from({ length: 100 }, (_, i) => ({ tag_name: `v1.0.${i}` })));
      return Response.json([draft]);
    },
  });
  assert.deepEqual(await getRelease("v0.5.1"), draft);
  assert.equal(paths.length, 3);
  assert(paths[2].endsWith("page=2"));
});

test("タグAPIも一覧も空の場合にだけ未作成と判断する", async () => {
  const { getRelease } = createGitHubClient({ apiUrl: "https://api.example.test", repo: "test/repo", token: "fake",
    fetchImpl: async (url) => url.includes("/tags/") ? new Response("", { status: 404 }) : Response.json([]),
  });
  assert.equal(await getRelease("v0.5.1"), null);
});

test("権限エラーをRelease未作成として扱わない", async () => {
  const { getRelease } = createGitHubClient({ apiUrl: "https://api.example.test", repo: "test/repo", token: "fake",
    fetchImpl: async () => new Response("", { status: 403 }),
  });
  await assert.rejects(getRelease("v0.5.1"), /HTTP 403/);
});
