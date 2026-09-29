import { findDraftIssues } from "../agents/draft";
import type { DraftRow, DraftStatus } from "../db/queries";

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TABS: DraftStatus[] = ["pending", "approved", "sent", "rejected"];

function card(d: DraftRow): string {
  const body = d.edited_body ?? d.body;
  const issues = findDraftIssues(body);
  const editable = d.status === "pending" || d.status === "approved";
  const actions: string[] = [];
  const post = (action: string, label: string, cls = "") =>
    `<form method="post" action="/drafts/${d.id}/${action}"><button class="${cls}">${label}</button></form>`;
  if (d.status === "pending") actions.push(post("approve", "Approve", "ok"), post("reject", "Reject", "no"));
  if (d.status === "approved") actions.push(post("sent", "Mark as sent", "ok"), post("reject", "Reject", "no"));

  return `<article>
  <header>
    <a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Open original post ↗</a>
    <span class="meta">score ${d.score.toFixed(2)} · ${esc(d.kind)}${d.edited_body ? " · edited" : ""}</span>
  </header>
  <p class="pain">${esc(d.pain_summary)}</p>
  ${issues.length ? `<p class="warn">Check before sending: ${esc(issues.join("; "))}</p>` : ""}
  ${
    editable
      ? `<form method="post" action="/drafts/${d.id}/edit">
      <textarea name="body" id="b${d.id}" rows="6">${esc(body)}</textarea>
      <div class="row"><button>Save edit</button><button type="button" class="copy" data-target="b${d.id}">Copy</button>${actions.join("")}</div>
    </form>`
      : `<textarea readonly id="b${d.id}" rows="6">${esc(body)}</textarea>
    <div class="row"><button type="button" class="copy" data-target="b${d.id}">Copy</button></div>`
  }
</article>`;
}

export function renderDashboard(drafts: DraftRow[], status: DraftStatus, email: string): string {
  const tabs = TABS.map(
    (t) => `<a href="/?status=${t}" class="${t === status ? "active" : ""}">${t}</a>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Draft approvals</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--mut:#666;--line:#ddd;--acc:#0b5fff;--ok:#0a7d33;--no:#b42318;--warn:#8a5a00}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--mut:#999;--line:#333;--acc:#6ea0ff;--ok:#4cc46d;--no:#ff7b72;--warn:#e3b341}}
body{margin:0 auto;max-width:760px;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
nav a{margin-right:12px;color:var(--mut);text-decoration:none;text-transform:capitalize}
nav a.active{color:var(--fg);font-weight:600;border-bottom:2px solid var(--acc)}
article{border:1px solid var(--line);border-radius:8px;padding:12px;margin:12px 0}
header{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
a{color:var(--acc)}.meta{color:var(--mut);font-size:13px}.pain{margin:.5em 0;font-weight:600}
.warn{color:var(--warn);font-size:13px;margin:.3em 0}
textarea{width:100%;box-sizing:border-box;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:8px;font:inherit}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}.row form{margin:0}
button{padding:6px 12px;border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:6px;cursor:pointer;font:inherit}
button.ok{border-color:var(--ok);color:var(--ok)}button.no{border-color:var(--no);color:var(--no)}
.empty{color:var(--mut)}.who{color:var(--mut);font-size:13px}
</style></head><body>
<h1>Draft approvals</h1><p class="who">Signed in as ${esc(email)}. Nothing is sent from here: copy, post it yourself, then mark as sent.</p>
<nav>${tabs}</nav>
${drafts.length ? drafts.map(card).join("") : `<p class="empty">No ${status} drafts.</p>`}
<script>
document.querySelectorAll("button.copy").forEach(function(b){
  b.addEventListener("click",function(){
    var t=document.getElementById(b.dataset.target);
    navigator.clipboard.writeText(t.value).then(function(){var o=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=o},1200)});
  });
});
</script>
</body></html>`;
}
