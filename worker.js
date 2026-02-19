/**
 * Botify.kz — Telegram → Blog Worker
 * Деплоить на: Cloudflare Workers (cloudflare.com/workers)
 *
 * Переменные окружения (Settings → Variables):
 *   GITHUB_TOKEN   — (задать в Cloudflare Workers → Settings → Variables)
 *   GITHUB_REPO    — EldarGGG/botify_site
 *   TG_BOT_TOKEN   — 8071707044:AAFltW97sUg0WgsWR4eZDCrDvneVIh5xykU
 *   TG_ADMIN_ID    — 1080443775
 *
 * Формат поста в Telegram:
 * ───────────────────────
 * #блог
 * Заголовок статьи
 *
 * Категория: AI для продаж
 *
 * Текст статьи, любой длины.
 * Можно несколько абзацев — каждый абзац через пустую строку.
 * ───────────────────────
 */

const GITHUB_REPO = 'EldarGGG/botify_site';
const GITHUB_BRANCH = 'main';

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK');

    let body;
    try { body = await request.json(); } catch { return new Response('OK'); }

    const msg = body?.message;
    if (!msg) return new Response('OK');

    // Только от админа
    if (String(msg.chat?.id) !== String(env.TG_ADMIN_ID)) {
      return new Response('OK');
    }

    const text = msg.text || '';

    // Команда /help
    if (text.trim() === '/help') {
      await tgSend(env, `*Формат публикации статьи:*\n\n\`\`\`\n#блог\nЗаголовок статьи\n\nКатегория: AI для продаж\n\nТекст первого абзаца.\n\nТекст второго абзаца.\n\`\`\`\n\n*Доступные категории:*\nAI для продаж, AI для поддержки, AI для HR, CRM интеграция, Кейсы, Обновления`);
      return new Response('OK');
    }

    // Проверяем что это пост для блога
    if (!text.startsWith('#блог') && !text.startsWith('#blog')) {
      return new Response('OK');
    }

    // Парсим пост
    const lines = text.split('\n');
    lines.shift(); // убираем #блог

    // Первая непустая строка = заголовок
    let title = '';
    let startIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) { title = lines[i].trim(); startIdx = i + 1; break; }
    }

    if (!title) {
      await tgSend(env, '❌ Не найден заголовок. Первая строка после #блог — заголовок статьи.');
      return new Response('OK');
    }

    // Ищем категорию
    let category = 'Блог';
    const remaining = lines.slice(startIdx);
    const catLineIdx = remaining.findIndex(l => l.toLowerCase().startsWith('категория:'));
    if (catLineIdx !== -1) {
      category = remaining[catLineIdx].split(':').slice(1).join(':').trim();
      remaining.splice(catLineIdx, 1);
    }

    // Остаток = текст статьи
    const bodyText = remaining.join('\n').trim();
    if (!bodyText) {
      await tgSend(env, '❌ Не найден текст статьи.');
      return new Response('OK');
    }

    // Генерируем slug и дату
    const date = new Date();
    const dateStr = date.toISOString().split('T')[0]; // 2025-02-19
    const dateRu = date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const slug = slugify(title) + '-' + dateStr;
    const filename = `blog/${slug}.html`;

    // Конвертируем текст в HTML параграфы
    const htmlBody = bodyText
      .split(/\n\n+/)
      .map(p => `  <p>${p.replace(/\n/g, '<br>').trim()}</p>`)
      .join('\n');

    // Генерируем HTML страницы
    const html = generateHTML({ title, category, dateStr, dateRu, slug, htmlBody });

    // Пушим в GitHub
    try {
      await githubCreateFile(env, filename, html);
    } catch (e) {
      await tgSend(env, `❌ Ошибка GitHub: ${e.message}`);
      return new Response('OK');
    }

    // Обновляем индекс блога
    try {
      await updateBlogIndex(env, { title, category, dateStr, dateRu, slug });
    } catch (e) {
      // не критично — статья уже создана
      console.error('Blog index update failed:', e);
    }

    const url = `https://botify.kz/blog/${slug}.html`;
    await tgSend(env, `✅ *Статья опубликована!*\n\n📝 ${title}\n🏷 ${category}\n📅 ${dateRu}\n\n🔗 ${url}\n\nNetlify задеплоит за ~30 секунд.`);

    return new Response('OK');
  }
};

// ─── Helpers ────────────────────────────────────────────────

function slugify(str) {
  const ru = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return str.toLowerCase()
    .split('').map(c => ru[c] || c).join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

async function tgSend(env, text) {
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_ADMIN_ID, text, parse_mode: 'Markdown' })
  });
}

async function githubCreateFile(env, path, content) {
  // Проверяем существует ли файл (получаем sha если да)
  let sha;
  const checkRes = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'botify-blog-bot' }
  });
  if (checkRes.ok) {
    const existing = await checkRes.json();
    sha = existing.sha;
  }

  const body = { message: `Add blog post: ${path}`, content: btoa(unescape(encodeURIComponent(content))), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'botify-blog-bot' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || res.statusText);
  }
}

async function updateBlogIndex(env, { title, category, dateStr, dateRu, slug }) {
  const path = 'blog-index.json';
  let posts = [];
  let sha;

  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'botify-blog-bot' }
  });

  if (res.ok) {
    const data = await res.json();
    sha = data.sha;
    posts = JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))));
  }

  posts.unshift({ title, category, date: dateStr, dateRu, slug, url: `blog/${slug}.html` });

  const content = JSON.stringify(posts, null, 2);
  const body = { message: `Update blog index`, content: btoa(unescape(encodeURIComponent(content))), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;

  await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'botify-blog-bot' },
    body: JSON.stringify(body)
  });
}

function generateHTML({ title, category, dateStr, dateRu, slug, htmlBody }) {
  return `<!DOCTYPE html>
<html lang="ru" data-theme="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — Botify.kz</title>
  <meta name="description" content="${title}. Блог Botify.kz — AI-интегратор для бизнеса в Казахстане.">
  <link rel="icon" type="image/png" href="../favicon.png">
  <link rel="canonical" href="https://botify.kz/blog/${slug}.html">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://botify.kz/blog/${slug}.html">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${title}. Блог Botify.kz.">
  <meta property="og:site_name" content="Botify.kz">
  <meta property="og:locale" content="ru_RU">
  <meta property="article:published_time" content="${dateStr}">
  <meta property="article:author" content="Botify.kz">
  <meta property="article:section" content="${category}">
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-DMBHYCQ2NR"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-DMBHYCQ2NR');</script>
  <link rel="stylesheet" href="../styles.css">
  <script>(function(){var t=localStorage.getItem('botify-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);}else if(window.matchMedia('(prefers-color-scheme: light)').matches){document.documentElement.setAttribute('data-theme','light');}})();</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"${title}","datePublished":"${dateStr}","author":{"@type":"Organization","name":"Botify.kz","url":"https://botify.kz"},"publisher":{"@type":"Organization","name":"Botify.kz","url":"https://botify.kz"},"articleSection":"${category}"}</script>
  <style>
    .article-hero { padding: 80px 0 48px; }
    .article-meta { display:flex; align-items:center; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
    .article-cat { font-size:0.75rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--cyan); background:var(--cyan-glow); border:1px solid var(--border-cyan); padding:4px 12px; border-radius:20px; }
    .article-date { font-size:0.875rem; color:var(--text-muted); }
    .article-title { font-size:clamp(1.75rem,4vw,2.75rem); font-weight:800; line-height:1.2; letter-spacing:-0.02em; margin-bottom:20px; }
    .article-body { max-width:720px; margin:0 auto; }
    .article-body p { font-size:1.0625rem; line-height:1.8; color:var(--text-secondary); margin-bottom:24px; }
    .article-divider { height:1px; background:var(--border); margin:48px 0; }
    .back-link { display:inline-flex; align-items:center; gap:8px; font-size:0.9rem; color:var(--text-muted); transition:color 160ms; margin-bottom:40px; }
    .back-link:hover { color:var(--cyan); }
    .back-link svg { width:16px; height:16px; }
  </style>
</head>
<body>

<nav class="navbar" id="navbar">
  <a href="../index.html" class="navbar-logo">botify<span>.kz</span></a>
  <div class="navbar-nav">
    <a href="../index.html" class="nav-link">Главная</a>
    <a href="../solutions.html" class="nav-link">Решения</a>
    <a href="../cases.html" class="nav-link">Кейсы</a>
    <a href="../platform.html" class="nav-link">Платформа</a>
    <a href="../about.html" class="nav-link">О нас</a>
    <a href="../blog.html" class="nav-link active">Блог</a>
    <a href="../contacts.html" class="nav-link">Контакты</a>
  </div>
  <div class="navbar-actions">
    <button class="theme-toggle" id="themeToggle" aria-label="Переключить тему">
      <svg class="icon-moon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      <svg class="icon-sun" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
    </button>
    <a href="../contacts.html" class="btn-nav">Получить аудит</a>
    <button class="hamburger" id="hamburger" aria-label="Меню">
      <span></span><span></span><span></span>
    </button>
  </div>
</nav>

<div class="mobile-menu" id="mobileMenu">
  <a href="../index.html">Главная</a>
  <a href="../solutions.html">Решения</a>
  <a href="../cases.html">Кейсы</a>
  <a href="../platform.html">Платформа</a>
  <a href="../about.html">О нас</a>
  <a href="../blog.html">Блог</a>
  <a href="../contacts.html">Контакты</a>
  <a href="../contacts.html" class="btn-nav" style="text-align:center;margin-top:8px;border-radius:9px;">Получить аудит</a>
</div>

<div class="article-hero">
  <div class="container">
    <a href="../blog.html" class="back-link">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg>
      Все статьи
    </a>
    <div class="article-meta">
      <span class="article-cat">${category}</span>
      <span class="article-date">${dateRu}</span>
    </div>
    <h1 class="article-title">${title}</h1>
  </div>
</div>

<section style="padding-bottom:96px">
  <div class="container">
    <div class="article-body">
${htmlBody}
      <div class="article-divider"></div>
      <div style="background:var(--bg-card);border:1px solid var(--border-cyan);border-radius:var(--radius-lg);padding:32px;text-align:center">
        <h3 style="margin-bottom:12px">Хотите внедрить AI в свой бизнес?</h3>
        <p style="color:var(--text-secondary);margin-bottom:24px">Получите бесплатный аудит бизнес-процессов и план автоматизации</p>
        <a href="../contacts.html" class="btn btn-primary">Получить аудит бесплатно</a>
      </div>
    </div>
  </div>
</section>

<footer class="footer">
  <div class="container">
    <div class="footer-bottom" style="padding-top:0;border-top:none">
      <p>&copy; 2025 botify.kz — AI-интеграции для бизнеса в Казахстане</p>
      <a href="../blog.html" style="font-size:0.875rem;color:var(--text-muted)">← Все статьи</a>
    </div>
  </div>
</footer>

<script src="../app.js"></script>
</body>
</html>`;
}
