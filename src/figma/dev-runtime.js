// Code generation is callback-driven and cannot open the ordinary bridge UI.
/* exported startCodegenPlugin */
function startCodegenPlugin() {
  figma.codegen.on('generate', async ({ node, language }) => {
    if (language === 'css') {
      const css = await node.getCSSAsync();
      return [
        {
          title: node.name,
          language: 'CSS',
          code: Object.entries(css)
            .map(([key, value]) => `${key}: ${value};`)
            .join('\n'),
        },
      ];
    }
    return [
      {
        title: node.name,
        language: 'JSON',
        code: JSON.stringify(
          {
            id: node.id,
            type: node.type,
            name: node.name,
            ...(typeof node.width === 'number'
              ? { width: node.width, height: node.height }
              : {}),
          },
          null,
          2,
        ),
      },
    ];
  });
}
