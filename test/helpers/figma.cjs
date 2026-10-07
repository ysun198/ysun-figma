const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Native API boundary double: models ownership, removal and injected failures;
// it intentionally does not claim to simulate Figma layout or rendering.
function fixture() {
  let next = 0;
  const nodes = [],
    collections = [],
    variables = [],
    calls = { commits: 0, creates: 0, switches: 0, fonts: [] };
  const faults = {};
  const identity = () => ({
    id: `0:${++next}`,
    data: {},
    getPluginData(key) {
      return this.data[key] || '';
    },
    setPluginData(key, value) {
      this.data[key] = value;
    },
  });
  const makeNode = (type) => {
    calls.creates++;
    const node = Object.assign(identity(), {
      type,
      name: type,
      children: [],
      selection: [],
      removed: false,
      opacity: 1,
      visible: true,
      width: 100,
      height: 100,
      fills: [],
      strokes: [],
      effects: [],
      cornerRadius: 0,
      rotation: 0,
      layoutMode: 'NONE',
      appendChild(child) {
        if (child.parent)
          child.parent.children = child.parent.children.filter(
            (item) => item !== child,
          );
        child.parent = this;
        this.children.push(child);
      },
      remove() {
        if (faults.removeId === this.id)
          throw new Error('native removal failed');
        if (this.parent)
          this.parent.children = this.parent.children.filter(
            (item) => item !== this,
          );
        for (const child of [...this.children]) child.remove();
        this.removed = true;
      },
      resize(width, height) {
        this.width = width;
        this.height = height;
      },
      async loadAsync() {},
      on() {},
      setBoundVariable() {},
      async setReactionsAsync(value) {
        if (faults.reactions) throw new Error('reaction failed');
        this.reactions = value;
      },
    });
    nodes.push(node);
    return node;
  };
  const root = makeNode('DOCUMENT'),
    initial = makeNode('PAGE');
  root.appendChild(initial);
  const figma = {
    root,
    currentPage: initial,
    editorType: 'figma',
    apiVersion: '1.0.0',
    async getNodeByIdAsync(id) {
      return nodes.find((node) => node.id === id && !node.removed) || null;
    },
    base64Encode(bytes) {
      return Buffer.from(bytes).toString('base64');
    },
    async setCurrentPageAsync(page) {
      if (page.removed) throw new Error('removed page');
      calls.switches++;
      this.currentPage = page;
    },
    createPage() {
      const node = makeNode('PAGE');
      root.appendChild(node);
      return node;
    },
    async loadFontAsync(font) {
      calls.fonts.push(font);
      if (faults.font) throw new Error('missing font');
    },
    async listAvailableFontsAsync() {
      return [{ fontName: { family: 'Inter', style: 'Regular' } }];
    },
    commitUndo() {
      calls.commits++;
    },
    viewport: { scrollAndZoomIntoView() {} },
    async saveVersionHistoryAsync() {
      if (faults.version) throw new Error('offline');
      return { id: 'version-1' };
    },
    variables: {
      async getLocalVariableCollectionsAsync() {
        return collections.filter((item) => !item.removed);
      },
      async getLocalVariablesAsync() {
        return variables.filter((item) => !item.removed);
      },
      createVariableCollection(name) {
        const collection = Object.assign(identity(), {
          name,
          modes: [{ modeId: 'mode-1', name: 'Original mode' }],
          defaultModeId: 'mode-1',
          remove() {
            this.removed = true;
          },
        });
        collections.push(collection);
        return collection;
      },
      createVariable(name, collection, resolvedType) {
        const variable = Object.assign(identity(), {
          name,
          resolvedType,
          variableCollectionId: collection.id,
          valuesByMode: {},
          scopes: ['ALL_SCOPES'],
          codeSyntax: {},
          setValueForMode(id, value) {
            this.valuesByMode[id] = value;
          },
          setVariableCodeSyntax(platform, value) {
            this.codeSyntax[platform] = value;
          },
          removeVariableCodeSyntax(platform) {
            delete this.codeSyntax[platform];
          },
          remove() {
            this.removed = true;
          },
        });
        variables.push(variable);
        return variable;
      },
      setBoundVariableForPaint(paint, property, variable) {
        return { ...paint, boundVariables: { [property]: variable.id } };
      },
    },
  };
  for (const [method, type] of Object.entries({
    createFrame: 'FRAME',
    createRectangle: 'RECTANGLE',
    createEllipse: 'ELLIPSE',
    createLine: 'LINE',
    createText: 'TEXT',
    createNodeFromSvg: 'FRAME',
  })) {
    figma[method] = () => {
      if (faults.createType === type) throw new Error('render failed');
      const node = makeNode(type);
      figma.currentPage.appendChild(node);
      return node;
    };
  }
  const context = vm.createContext({ console, Uint8Array });
  vm.runInContext(
    ['shared/core.js', 'figma/design-queries.js', 'figma/script-runtime.js']
      .map((name) =>
        fs.readFileSync(path.join(__dirname, '../../src', name), 'utf8'),
      )
      .join('\n'),
    context,
  );
  context.figma = figma;
  return {
    api: context,
    figma,
    nodes,
    collections,
    variables,
    calls,
    faults,
    initial,
  };
}
module.exports = { fixture };
