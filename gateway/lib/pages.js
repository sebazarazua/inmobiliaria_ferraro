function html(res,status,body){
  res.statusCode=status;
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','public, max-age=3600');
  res.end(body);
}

function page({title,description,sections}){
  const renderedSections=sections.map(section=>`
      <section>
        <h2>${section.title}</h2>
        ${section.body}
      </section>`).join('');
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <style>
      :root { color-scheme: light; font-family: Arial, Helvetica, sans-serif; color: #1f2933; background: #f6f7f9; }
      body { margin: 0; }
      main { max-width: 760px; margin: 0 auto; padding: 48px 20px 64px; }
      article { background: #fff; border: 1px solid #dde3ea; border-radius: 8px; padding: 32px; box-shadow: 0 8px 28px rgba(31,41,51,.06); }
      h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.15; }
      h2 { margin: 28px 0 8px; font-size: 18px; line-height: 1.3; }
      p, li { font-size: 16px; line-height: 1.6; }
      p { margin: 0 0 14px; }
      ul { margin: 0 0 14px; padding-left: 22px; }
      .muted { color: #5d6977; }
      a { color: #0f5f8c; }
      footer { margin-top: 28px; font-size: 14px; color: #5d6977; }
      @media (max-width: 560px) {
        main { padding: 24px 12px 40px; }
        article { padding: 22px; }
        h1 { font-size: 26px; }
      }
    </style>
  </head>
  <body>
    <main>
      <article>
        <h1>${title}</h1>
        <p class="muted">${description}</p>
        ${renderedSections}
        <footer>Jurisdiccion: Republica Argentina.</footer>
      </article>
    </main>
  </body>
</html>`;
}

module.exports={html,page};
