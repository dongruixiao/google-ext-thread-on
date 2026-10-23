const post = document.querySelector('#post');
let appended = 0;

document.querySelector('#btn-append').addEventListener('click', () => {
  appended += 1;
  const section = document.createElement('section');
  const headingId = `appendix-dynamic-${appended}`;
  section.innerHTML = `
    <h2 id="${headingId}">动态追加的小节 ${appended}</h2>
    <p>
      MutationObserver 应该捕获到这段新插入的内容，并自动把标题重新索引进来。
      打开胶囊的悬停大纲，你应该能在列表里看到这个新标题，并且可以点击跳转。
    </p>
    <h3>小节 ${appended}.1</h3>
    <p>
      这里顺便验证层级链：新插入的 h3 应当挂在上面这个 h2 下面，
      因此滚动到这一段时，胶囊应切换到动态追加的小节标题。
    </p>
  `;
  post.appendChild(section);
});

document.querySelector('#btn-list').addEventListener('click', () => {
  const page = document.querySelector('.page');
  const cards = Array.from(
    { length: 8 },
    (_, index) => `
      <article class="card">
        <h2>示例文章标题 ${index + 1}：一段并不算长但也不算短的摘要式标题</h2>
        <p>这是列表页里的摘要文本，长度有限，用于验证插件不会在聚合列表页误激活。</p>
      </article>
    `,
  ).join('');
  page.innerHTML = `<div class="card-grid">${cards}</div>`;
  document.title = '文章列表 · Demo 博客';
});

document.querySelector('#btn-reset').addEventListener('click', () => {
  location.reload();
});

document.querySelector('#btn-toc').addEventListener('click', () => {
  const toc = document.querySelector('#site-toc');
  toc.hidden = !toc.hidden;
});
