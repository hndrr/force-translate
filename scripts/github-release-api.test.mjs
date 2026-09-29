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

test("draft作成レスポンスのIDで取得・公開でき、検索の反映を待たない", async () => {
  let release = null;
  const base = "https://api.example.test/repos/test/repo";
  const client = createGitHubClient({ apiUrl: "https://api.example.test", repo: "test/repo", token: "fake",
    async fetchImpl(url, options) {
      assert.equal(options.cache, "no-store");
      if (url === `${base}/releases` && options.method === "POST") {
        assert.equal(options.headers["Content-Type"], "application/json");
        assert.deepEqual(JSON.parse(options.body), {
          tag_name: "v0.5.1", target_commitish: "commit", name: "Force Translate v0.5.1",
          draft: true, generate_release_notes: true,
        });
        release = { id: 42, tag_name: "v0.5.1", target_commitish: "commit", draft: true, assets: [] };
        return Response.json(release, { status: 201 });
      }
      if (url === `${base}/releases/42`) {
        if (options.method === "PATCH") {
          assert.deepEqual(JSON.parse(options.body), { draft: false });
          release.draft = false;
        } else {
          assert.equal(options.method, "GET");
        }
        return Response.json(release);
      }
      if (url === `${base}/releases/tags/v0.5.1`) return new Response("", { status: 404 });
      assert.equal(url, `${base}/releases?per_page=100&page=1`);
      return Response.json([]);
    },
  });
  const draft = await client.createDraft("v0.5.1", "commit");
  assert.equal(await client.getRelease("v0.5.1"), null);
  assert.deepEqual(await client.getReleaseById(draft.id), draft);
  assert.equal((await client.publishDraft(draft.id)).draft, false);
  assert.equal((await client.getReleaseById(draft.id)).draft, false);
});
