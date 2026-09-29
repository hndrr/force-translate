/** Create a repository-scoped API client that can also find unpublished drafts. */
export function createGitHubClient({ apiUrl, repo, token, fetchImpl = fetch }) {
  const base = `${apiUrl}/repos/${repo}`;

  /** Only an explicit 404 is absence; propagate permission and network errors. */
  async function request(endpoint, { binary = false, optional = false } = {}) {
    const response = await fetchImpl(`${base}/${endpoint}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: binary ? "application/octet-stream" : "application/vnd.github+json",
      },
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status} (${endpoint})`);
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  /** The tag endpoint only promises published releases; paginate to find drafts. */
  async function getRelease(tag) {
    const published = await request(`releases/tags/${encodeURIComponent(tag)}`, { optional: true });
    if (published) return published;
    for (let page = 1; ; page++) {
      const releases = await request(`releases?per_page=100&page=${page}`);
      const found = releases.find((release) => release.tag_name === tag);
      if (found) return found;
      if (releases.length < 100) return null;
    }
  }
  return { request, getRelease };
}
