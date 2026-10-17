// Jans Holzstube – Speichern ins GitHub-Repo über die GitHub-API.
// Alle geänderten Dateien landen zusammen in einem einzigen Commit.

const API = "https://api.github.com";

export function textZuBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export function base64ZuText(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export class GitHub {
  constructor({ owner, repo, branch, token }) {
    this.owner = (owner || "").trim();
    this.repo = (repo || "").trim();
    this.branch = (branch || "main").trim();
    this.token = (token || "").trim();
  }

  get bereit() { return !!(this.owner && this.repo && this.token); }

  async anfrage(pfad, optionen = {}) {
    const res = await fetch(`${API}/repos/${this.owner}/${this.repo}${pfad}`, {
      ...optionen,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(optionen.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!res.ok) {
      let text = "";
      try { text = (await res.json()).message || ""; } catch { /* leer */ }
      const fehler = new Error(GitHub.erklaere(res.status, text));
      fehler.status = res.status;
      throw fehler;
    }
    return res.status === 204 ? null : res.json();
  }

  static erklaere(status, text) {
    if (status === 401) return "Der Zugangsschlüssel (Token) ist ungültig oder abgelaufen.";
    if (status === 403) return "Keine Berechtigung. Hat der Token Lese- und Schreibrechte für „Contents“?" + (text ? ` (${text})` : "");
    if (status === 404) return "Repo, Branch oder Datei nicht gefunden. Stimmen Benutzername und Repo-Name?";
    if (status === 409 || status === 422) return "GitHub hat die Änderung abgelehnt (Konflikt). Bitte neu laden und noch einmal versuchen." + (text ? ` (${text})` : "");
    return `GitHub-Fehler ${status}${text ? `: ${text}` : ""}`;
  }

  async pruefe() {
    const info = await this.anfrage("");
    await this.anfrage(`/branches/${encodeURIComponent(this.branch)}`);
    return { privat: info.private, name: info.full_name, schreiben: !!(info.permissions && info.permissions.push) };
  }

  async ladeText(pfad) {
    const d = await this.anfrage(`/contents/${pfad}?ref=${encodeURIComponent(this.branch)}`);
    return { text: base64ZuText(d.content || ""), sha: d.sha };
  }

  // dateien: [{ pfad, text } oder { pfad, base64 }]
  async commit(dateien, nachricht) {
    const ref = await this.anfrage(`/git/ref/heads/${encodeURIComponent(this.branch)}`);
    const basisCommit = ref.object.sha;
    const commitInfo = await this.anfrage(`/git/commits/${basisCommit}`);
    const baum = [];
    for (const d of dateien) {
      const blob = await this.anfrage("/git/blobs", {
        method: "POST",
        body: JSON.stringify({ content: d.base64 ?? textZuBase64(d.text), encoding: "base64" }),
      });
      baum.push({ path: d.pfad, mode: "100644", type: "blob", sha: blob.sha });
    }
    const neuerBaum = await this.anfrage("/git/trees", {
      method: "POST", body: JSON.stringify({ base_tree: commitInfo.tree.sha, tree: baum }),
    });
    const neu = await this.anfrage("/git/commits", {
      method: "POST", body: JSON.stringify({ message: nachricht, tree: neuerBaum.sha, parents: [basisCommit] }),
    });
    await this.anfrage(`/git/refs/heads/${encodeURIComponent(this.branch)}`, {
      method: "PATCH", body: JSON.stringify({ sha: neu.sha }),
    });
    return neu.sha;
  }
}
