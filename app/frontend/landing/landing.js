/* landing.js — interaksi landing page TechnoFix */
'use strict';

/* Tahun footer */
document.getElementById('lpYear').textContent = new Date().getFullYear();

/* Navbar shadow saat scroll */
const nav = document.getElementById('lpNav');
window.addEventListener('scroll', function () {
  nav.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

/* Menu mobile */
const burger = document.getElementById('lpBurger');
const links  = document.getElementById('lpNavLinks');
burger?.addEventListener('click', function () { links.classList.toggle('open'); });
links?.querySelectorAll('a').forEach(function (a) {
  a.addEventListener('click', function () { links.classList.remove('open'); });
});

/* ── Animasi jaringan di hero (canvas) — node + garis terhubung ── */
(function networkAnim() {
  const canvas = document.getElementById('lpHeroCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, nodes, raf;
  const COUNT = 46, LINK_DIST = 130;

  function resize() {
    w = canvas.width  = canvas.offsetWidth  * devicePixelRatio;
    h = canvas.height = canvas.offsetHeight * devicePixelRatio;
  }
  function init() {
    nodes = [];
    for (let i = 0; i < COUNT; i++) {
      nodes.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.25 * devicePixelRatio,
        vy: (Math.random() - 0.5) * 0.25 * devicePixelRatio,
        r: (Math.random() * 1.6 + 1) * devicePixelRatio,
      });
    }
  }
  function frame() {
    ctx.clearRect(0, 0, w, h);
    const dist = LINK_DIST * devicePixelRatio;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.x += n.vx; n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
      for (let j = i + 1; j < nodes.length; j++) {
        const m = nodes[j];
        const dx = n.x - m.x, dy = n.y - m.y;
        const d = Math.hypot(dx, dy);
        if (d < dist) {
          ctx.strokeStyle = 'rgba(29,78,216,' + (0.16 * (1 - d / dist)) + ')';
          ctx.lineWidth = 1 * devicePixelRatio;
          ctx.beginPath(); ctx.moveTo(n.x, n.y); ctx.lineTo(m.x, m.y); ctx.stroke();
        }
      }
      ctx.fillStyle = 'rgba(0,64,161,.5)';
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  function start() { resize(); init(); cancelAnimationFrame(raf); frame(); }
  window.addEventListener('resize', start);
  start();
})();
