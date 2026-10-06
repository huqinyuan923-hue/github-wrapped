/* GitHub 年度报告 · Wrapped —— 纯前端，数据来自 GitHub 公开 API */
"use strict";

const $ = (sel) => document.querySelector(sel);

const API = "https://api.github.com";
const CACHE_TTL = 10 * 60 * 1000; // 结果缓存 10 分钟，防止限流
const REPO_PAGES = 3;             // 最多取 300 个仓库

/* ================= 小工具 ================= */

function fmtNum(n) {
  if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function yearsSince(iso) {
  return Math.floor((Date.now() - new Date(iso).getTime()) / (365.25 * 86400000));
}

/** 码龄：不满 1 年按月显示 */
function ageText(iso) {
  const days = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (days < 365) {
    const months = Math.max(1, Math.round(days / 30.4));
    return months + " 个月";
  }
  return yearsSince(iso) + " 年";
}

function cacheGet(key) {
  try {
    const hit = JSON.parse(sessionStorage.getItem(key));
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  } catch { /* 忽略 */ }
  return null;
}
function cacheSet(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch { /* 存储满则忽略 */ }
}

const TOKEN_KEY = "ghw-token";

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

async function ghFetch(path) {
  const headers = { Accept: "application/vnd.github+json" };
  const token = getToken();
  if (token) headers.Authorization = "Bearer " + token;
  const res = await fetch(API + path, { headers });
  if (res.status === 404) {
    const err = new Error("NOT_FOUND");
    throw err;
  }
  if (res.status === 401) {
    throw new Error("BAD_TOKEN");
  }
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const waitMin = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : null;
    const err = new Error("RATE_LIMIT" + (waitMin ? ":" + waitMin : ""));
    throw err;
  }
  if (!res.ok) throw new Error("HTTP_" + res.status);
  return res.json();
}

/** 今年提交数：Search API 直接统计（一次请求，比 stats/participation 可靠） */
async function ghFetchCommitCount(login) {
  const year = new Date().getFullYear();
  const q = `author:${login} author-date:>=${year}-01-01`;
  const data = await ghFetch(`/search/commits?q=${encodeURIComponent(q)}&per_page=1`);
  return data.total_count || 0;
}

/* ================= 数据获取与统计 ================= */

async function fetchRepos(login) {
  const all = [];
  for (let page = 1; page <= REPO_PAGES; page++) {
    const list = await ghFetch(
      `/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&type=owner&page=${page}`);
    all.push(...list);
    if (list.length < 100) break;
  }
  return all;
}

function computeStats(profile, repos, commitsThisYear, events) {
  const own = repos.filter((r) => !r.fork);
  const year = new Date().getFullYear();

  // 语言分布：按仓库数计
  const langCount = {};
  for (const r of own) {
    if (r.language) langCount[r.language] = (langCount[r.language] || 0) + 1;
  }
  const langs = Object.entries(langCount).sort((a, b) => b[1] - a[1]).slice(0, 6);

  const topRepos = [...own].sort((a, b) => b.stargazers_count - a.stargazers_count).slice(0, 3);

  // 动态分类
  const evCount = {};
  let firstAt = null, lastAt = null;
  const days = new Set();
  for (const e of events) {
    evCount[e.type] = (evCount[e.type] || 0) + 1;
    if (!firstAt || e.created_at < firstAt) firstAt = e.created_at;
    if (!lastAt || e.created_at > lastAt) lastAt = e.created_at;
    if (e.created_at) days.add(e.created_at.slice(0, 10));
  }
  const evTop = Object.entries(evCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return {
    login: profile.login,
    name: profile.name || profile.login,
    avatar: profile.avatar_url,
    followers: profile.followers,
    publicRepos: profile.public_repos,
    totalStars: repos.reduce((s, r) => s + r.stargazers_count, 0),
    totalForks: repos.reduce((s, r) => s + r.forks_count, 0),
    ageYears: yearsSince(profile.created_at),
    ageStr: ageText(profile.created_at),
    createdIso: profile.created_at,
    commitsThisYear,
    commitYear: year,
    langs,
    topRepos,
    evTop,
    evDays: days.size,
    evFirst: firstAt,
    evLast: lastAt,
  };
}

async function buildReport(rawLogin) {
  const login = rawLogin.trim();
  const cacheKey = "ghw:" + login.toLowerCase();

  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const profile = await ghFetch(`/users/${encodeURIComponent(login)}`);
  const [repos, commitsThisYear] = await Promise.all([
    fetchRepos(profile.login),
    ghFetchCommitCount(profile.login).catch(() => 0), // 搜索接口失败不阻塞主报告
  ]);

  let events = [];
  try {
    events = await ghFetch(`/users/${encodeURIComponent(profile.login)}/events/public?per_page=100`);
  } catch { /* 动态失败不影响主报告 */ }

  const stats = computeStats(profile, repos, commitsThisYear, events);
  cacheSet(cacheKey, stats);
  return stats;
}

/* ================= 报告渲染（DOM 全部用 textContent，防注入） ================= */

const EVENT_NAMES = {
  PushEvent: "推送代码", CreateEvent: "创建仓库/分支", WatchEvent: "Star 仓库",
  ForkEvent: "Fork 仓库", IssuesEvent: "Issue 操作", PullRequestEvent: "PR 操作",
  ReleaseEvent: "发布版本", DeleteEvent: "删除分支", IssueCommentEvent: "Issue 评论",
  PullRequestReviewEvent: "PR 审查", CommitCommentEvent: "提交评论", PublicEvent: "仓库开源",
  GollumEvent: "Wiki 编辑", MemberEvent: "协作者变更", GistEvent: "Gist",
};

function renderReport(s) {
  $("#rAvatar").src = s.avatar;
  $("#rName").textContent = s.name;
  $("#rLogin").textContent = "@" + s.login;
  $("#rProfileLink").href = "https://github.com/" + encodeURIComponent(s.login);

  $("#sCommits").textContent = fmtNum(s.commitsThisYear);
  $("#sRepos").textContent = fmtNum(s.publicRepos);
  $("#sStars").textContent = fmtNum(s.totalStars);
  $("#sFollowers").textContent = fmtNum(s.followers);
  $("#sAge").textContent = s.ageStr;
  $("#sForks").textContent = fmtNum(s.totalForks);

  // 语言条
  const langBars = $("#langBars");
  langBars.replaceChildren();
  const langMax = s.langs.length ? s.langs[0][1] : 1;
  for (const [name, count] of s.langs) {
    const row = document.createElement("div");
    row.className = "lang-row";
    const top = document.createElement("div");
    top.className = "lang-top";
    const nm = document.createElement("span");
    nm.textContent = name;
    const ct = document.createElement("i");
    ct.textContent = `${count} 个仓库`;
    top.append(nm, ct);
    const bar = document.createElement("div");
    bar.className = "lang-bar";
    const fill = document.createElement("i");
    fill.style.width = Math.round((count / langMax) * 100) + "%";
    bar.append(fill);
    row.append(top, bar);
    langBars.append(row);
  }
  if (!s.langs.length) langBars.textContent = "暂无语言数据";

  // 星标之最
  const topRepos = $("#topRepos");
  topRepos.replaceChildren();
  for (const r of s.topRepos) {
    const a = document.createElement("a");
    a.className = "repo-card";
    a.href = r.html_url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    const b = document.createElement("b");
    const nm = document.createElement("span");
    nm.textContent = r.name;
    const st = document.createElement("i");
    st.textContent = "★ " + fmtNum(r.stargazers_count);
    b.append(nm, st);
    const p = document.createElement("p");
    p.textContent = r.description || "（无描述）";
    p.title = r.description || "";
    a.append(b, p);
    topRepos.append(a);
  }
  if (!s.topRepos.length) topRepos.textContent = "暂无原创公开仓库";

  // 动态条
  const evBars = $("#eventBars");
  evBars.replaceChildren();
  const evMax = s.evTop.length ? s.evTop[0][1] : 1;
  for (const [type, count] of s.evTop) {
    const row = document.createElement("div");
    row.className = "ev-row";
    const nm = document.createElement("span");
    nm.className = "ev-name";
    nm.textContent = EVENT_NAMES[type] || type;
    const bar = document.createElement("div");
    bar.className = "ev-bar";
    const fill = document.createElement("i");
    fill.style.width = Math.round((count / evMax) * 100) + "%";
    bar.append(fill);
    const ct = document.createElement("span");
    ct.className = "ev-count";
    ct.textContent = String(count);
    row.append(nm, bar, ct);
    evBars.append(row);
  }
  if (!s.evTop.length) {
    evBars.textContent = "近期没有公开动态";
    $("#eventMeta").textContent = "";
  } else {
    const span = s.evFirst
      ? `${s.evFirst.slice(0, 10)} ~ ${s.evLast.slice(0, 10)}，其中活跃 ${s.evDays} 天`
      : "";
    $("#eventMeta").textContent = span;
  }

  drawShareCard(s);
}

/* ================= 分享卡片绘制 ================= */

function drawRoundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadAvatar(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // 加载失败则画首字母
    img.src = url;
  });
}

async function drawShareCard(s) {
  const canvas = $("#shareCard");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  const FONT = 'system-ui, "Microsoft YaHei", sans-serif';

  // 背景：深色渐变 + 光斑
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#12142e");
  bg.addColorStop(0.55, "#0d1024");
  bg.addColorStop(1, "#0a1a2e");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow1 = ctx.createRadialGradient(140, 60, 20, 140, 60, 320);
  glow1.addColorStop(0, "rgba(139,123,255,0.4)");
  glow1.addColorStop(1, "rgba(139,123,255,0)");
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, 400);
  const glow2 = ctx.createRadialGradient(1060, 580, 20, 1060, 580, 300);
  glow2.addColorStop(0, "rgba(76,201,240,0.32)");
  glow2.addColorStop(1, "rgba(76,201,240,0)");
  ctx.fillStyle = glow2;
  ctx.fillRect(W - 500, H - 460, 500, 460);

  // 顶部：头像 + 昵称
  const avatar = await loadAvatar(s.avatar);
  const ax = 56, ay = 52, ar = 44;
  ctx.save();
  ctx.beginPath();
  ctx.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, ax, ay, ar * 2, ar * 2);
  } else {
    ctx.fillStyle = "#8b7bff";
    ctx.fillRect(ax, ay, ar * 2, ar * 2);
    ctx.fillStyle = "#0d1024";
    ctx.font = `700 ${Math.round(ar * 1.1)}px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(s.login[0].toUpperCase(), ax + ar, ay + ar);
  }
  ctx.restore();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#eef0ff";
  ctx.font = `700 30px ${FONT}`;
  ctx.fillText(s.name, ax + ar * 2 + 20, ay + 40);
  ctx.fillStyle = "#9aa3d0";
  ctx.font = `400 20px ${FONT}`;
  ctx.fillText("@" + s.login, ax + ar * 2 + 20, ay + 70);

  // 年份徽标
  ctx.font = `800 22px ${FONT}`;
  const badge = `${s.commitYear} 年度报告`;
  const bw = ctx.measureText(badge).width + 36;
  const bgrad = ctx.createLinearGradient(0, 0, bw, 0);
  bgrad.addColorStop(0, "#8b7bff");
  bgrad.addColorStop(1, "#4cc9f0");
  ctx.fillStyle = bgrad;
  drawRoundedRect(ctx, W - bw - 56, 60, bw, 40, 20);
  ctx.fill();
  ctx.fillStyle = "#0d1024";
  ctx.textAlign = "center";
  ctx.fillText(badge, W - bw / 2 - 56, 87);

  // 主数字：今年提交
  ctx.textAlign = "left";
  ctx.fillStyle = "#9aa3d0";
  ctx.font = `400 22px ${FONT}`;
  ctx.fillText(`${s.commitYear} 年提交`, 60, 210);
  const mainNum = fmtNum(s.commitsThisYear);
  ctx.font = `800 110px ${FONT}`;
  const numGrad = ctx.createLinearGradient(60, 0, 400, 0);
  numGrad.addColorStop(0, "#8b7bff");
  numGrad.addColorStop(0.6, "#4cc9f0");
  numGrad.addColorStop(1, "#7af0c8");
  ctx.fillStyle = numGrad;
  ctx.fillText(mainNum, 56, 316);

  // 码龄卡片：月份显示时较长，压缩字号
  const cards = [
    ["公开仓库", String(s.publicRepos)],
    ["累计星标", String(s.totalStars)],
    ["粉丝", String(s.followers)],
    ["码龄", s.ageStr],
  ];
  const cw = (W - 60 * 2 - 18 * 3) / 4, cy = 360, ch = 96;
  cards.forEach(([label, value], i) => {
    const x = 60 + i * (cw + 18);
    ctx.fillStyle = "rgba(23,27,56,0.9)";
    drawRoundedRect(ctx, x, cy, cw, ch, 14);
    ctx.fill();
    ctx.strokeStyle = "rgba(76,201,240,0.25)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#eef0ff";
    // 值过长时缩字号，避免溢出卡片
    ctx.font = `800 ${value.length > 6 ? 26 : 34}px ${FONT}`;
    ctx.fillText(value, x + 18, cy + 48);
    ctx.fillStyle = "#9aa3d0";
    ctx.font = `400 17px ${FONT}`;
    ctx.fillText(label, x + 18, cy + 76);
  });

  // 语言 chips
  ctx.textAlign = "left";
  let lx = 60;
  const ly = 512;
  ctx.fillStyle = "#9aa3d0";
  ctx.font = `400 18px ${FONT}`;
  ctx.fillText("常用语言", 60, ly - 14);
  for (const [name] of s.langs.slice(0, 5)) {
    ctx.font = `600 18px ${FONT}`;
    const w = ctx.measureText(name).width + 28;
    ctx.fillStyle = "rgba(139,123,255,0.2)";
    drawRoundedRect(ctx, lx, ly, w, 36, 18);
    ctx.fill();
    ctx.fillStyle = "#c9c2ff";
    ctx.fillText(name, lx + 14, ly + 25);
    lx += w + 10;
    if (lx > W - 120) break;
  }

  // 底部
  ctx.fillStyle = "#5f689c";
  ctx.font = `400 16px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText("github.com/" + s.login, 60, H - 34);
  ctx.textAlign = "right";
  ctx.fillText("生成于 GitHub Wrapped · " + new Date().toISOString().slice(0, 10), W - 60, H - 34);
}

/* ================= 交互流程 ================= */

const form = $("#reportForm");
const usernameInput = $("#username");
const tokenInput = $("#tokenInput");
const goBtn = $("#goBtn");
const heroMsg = $("#heroMsg");
const loading = $("#loading");
const loadingText = $("#loadingText");
const report = $("#report");

const VALID_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

// Token 只保存在本浏览器
tokenInput.value = getToken();
tokenInput.addEventListener("change", () => {
  const t = tokenInput.value.trim();
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
  if (t && !/^(ghp|gho|github_pat)_[A-Za-z0-9_]+$/.test(t)) {
    showHeroMsg("⚠️ Token 格式看起来不太对，通常以 ghp_ / github_pat_ 开头", "err");
  } else {
    showHeroMsg(t ? "✓ Token 已保存到本浏览器" : "已清除 Token", "ok");
  }
});

function showHeroMsg(text, type) {
  heroMsg.textContent = text;
  heroMsg.className = "msg" + (type ? " " + type : "");
}

function switchView(view) {
  $("#hero").hidden = view !== "hero";
  loading.hidden = view !== "loading";
  report.hidden = view !== "report";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const login = usernameInput.value.trim();
  if (!VALID_LOGIN.test(login)) {
    showHeroMsg("✗ 请输入合法的 GitHub 用户名（字母、数字、连字符）", "err");
    return;
  }
  goBtn.disabled = true;
  showHeroMsg("");
  switchView("loading");
  loadingText.textContent = "正在从 GitHub 拉取 " + login + " 的数据…";
  try {
    const stats = await buildReport(login);
    renderReport(stats);
    switchView("report");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (err) {
    switchView("hero");
    if (err.message === "NOT_FOUND") {
      showHeroMsg("✗ 找不到用户 " + login + "，请检查拼写（注意大小写不敏感，但要确保存在）", "err");
    } else if (err.message === "BAD_TOKEN") {
      showHeroMsg("✗ 已保存的 Token 无效，请清除后重填。", "err");
    } else if (err.message.startsWith("RATE_LIMIT")) {
      const min = err.message.split(":")[1];
      showHeroMsg(min
        ? `✗ GitHub 接口限流，约 ${min} 分钟后恢复；或展开下方折叠框填入 Token 立即提升限额。`
        : "✗ GitHub 接口限流，请一小时后再试，或填入 Token 提升限额。", "err");
    } else if (err.message.startsWith("HTTP_")) {
      showHeroMsg("✗ GitHub 服务异常（" + err.message.slice(4) + "），请稍后再试。", "err");
    } else {
      showHeroMsg("✗ 网络异常，请检查网络后重试。", "err");
    }
  } finally {
    goBtn.disabled = false;
  }
});

$("#downloadBtn").addEventListener("click", (e) => {
  try {
    const a = document.createElement("a");
    a.download = `github-wrapped-${$("#rLogin").textContent.slice(1)}.png`;
    a.href = $("#shareCard").toDataURL("image/png");
    a.click();
  } catch {
    // 头像跨域污染画布等极端情况：按钮上直接给反馈
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = "✗ 导出失败，请刷新重试";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }
});

$("#retryBtn").addEventListener("click", () => {
  usernameInput.value = "";
  usernameInput.focus();
  switchView("hero");
});

// 支持 #/?u= 用户名直达
const initialUser = new URLSearchParams(location.search).get("u") || location.hash.slice(1);
if (initialUser && VALID_LOGIN.test(initialUser)) {
  usernameInput.value = initialUser;
  form.requestSubmit();
}
