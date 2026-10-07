// A viewport for Figma's rendered page. It owns no editable design model.
export function createCanvasView(app, $, onContext) {
  const viewport = $('canvas-viewport'),
    image = $('canvas-image'),
    pages = $('canvas-page'),
    sessions = $('canvas-session'),
    status = $('canvas-status'),
    retry = $('canvas-retry');
  let fileIdentity,
    viewportIdentity,
    file,
    accountId,
    clientId,
    pageId,
    target = null,
    desired,
    handled,
    running = false,
    writing = false,
    preview = null,
    geometry = null,
    fitted = true,
    drag,
    disposed = false,
    restoration;
  const position = { x: 0, y: 0, scale: 1 };
  function context(value) {
    preview = value;
    onContext(value);
  }
  function message(text = '', failed = false) {
    $('canvas-status-text').textContent = text;
    status.hidden = !text;
    retry.hidden = !failed;
  }
  function clear() {
    image.hidden = true;
    image.removeAttribute('src');
    geometry = null;
    viewport.style.background = '';
    drag = undefined;
    delete viewport.dataset.dragging;
    context(null);
    $('canvas-zoom').disabled = $('canvas-fit').disabled = true;
    $('canvas-minus').disabled = $('canvas-plus').disabled = true;
  }
  function paint() {
    image.style.transform = `translate(${position.x}px, ${position.y}px) scale(${position.scale})`;
    $('canvas-zoom').textContent = `${Math.round(position.scale * 100)}%`;
  }
  function fit() {
    if (!geometry) return;
    const box = viewport.getBoundingClientRect(),
      padding = parseFloat(getComputedStyle(viewport).paddingLeft) || 0;
    if (!box.width || !box.height) return;
    position.scale = Math.min(
      Math.max(1, box.width - 2 * padding) / geometry.width,
      Math.max(1, box.height - 2 * padding) / geometry.height,
    );
    position.x = (box.width - geometry.width * position.scale) / 2;
    position.y = (box.height - geometry.height * position.scale) / 2;
    fitted = true;
    paint();
  }
  function zoom(scale, x, y) {
    if (!geometry) return;
    // Fit may exceed the manual range; returning into it must stay continuous.
    const lower = Math.min(0.01, position.scale),
      upper = Math.max(64, position.scale),
      next = Math.max(lower, Math.min(upper, scale)),
      ratio = next / position.scale;
    position.x = x - (x - position.x) * ratio;
    position.y = y - (y - position.y) * ratio;
    position.scale = next;
    fitted = false;
    paint();
  }
  function zoomCenter(factor) {
    const box = viewport.getBoundingClientRect();
    zoom(position.scale * factor, box.width / 2, box.height / 2);
  }
  viewport.onpointerdown = (event) => {
    if (!geometry || ![0, 1].includes(event.button)) return;
    viewport.focus({ preventScroll: true });
    viewport.setPointerCapture(event.pointerId);
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    viewport.dataset.dragging = 'true';
    event.preventDefault();
  };
  viewport.onpointermove = (event) => {
    if (drag?.id !== event.pointerId) return;
    position.x += event.clientX - drag.x;
    position.y += event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    fitted = false;
    paint();
  };
  viewport.onlostpointercapture = () => {
    drag = undefined;
    delete viewport.dataset.dragging;
  };
  viewport.onpointerup = viewport.onpointercancel = (event) => {
    if (viewport.hasPointerCapture(event.pointerId))
      viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener(
    'wheel',
    (event) => {
      if (!geometry) return;
      event.preventDefault();
      const box = viewport.getBoundingClientRect(),
        unit =
          event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1;
      if (event.ctrlKey || event.metaKey)
        zoom(
          position.scale * Math.exp((-event.deltaY * unit) / 500),
          event.clientX - box.left,
          event.clientY - box.top,
        );
      else {
        position.x -= event.deltaX * unit;
        position.y -= event.deltaY * unit;
        fitted = false;
        paint();
      }
    },
    { passive: false },
  );
  viewport.onkeydown = (event) => {
    if (['+', '=', '-', '0'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0') fit();
      else zoomCenter(event.key === '-' ? 0.8 : 1.25);
    }
  };
  $('canvas-minus').onclick = () => zoomCenter(0.8);
  $('canvas-plus').onclick = () => zoomCenter(1.25);
  $('canvas-fit').onclick = fit;
  $('canvas-zoom').onclick = () => {
    const box = viewport.getBoundingClientRect();
    zoom(1, box.width / 2, box.height / 2);
  };
  const observer = new ResizeObserver(() => {
    if (fitted) fit();
  });
  observer.observe(viewport);
  function options(select, values, selected) {
    const choices = Array.from(select.children).filter(
      (child) => child.localName === 'option',
    );
    if (
      choices.length !== values.length ||
      choices.some(
        (choice, index) =>
          choice.value !== values[index][0] ||
          choice.textContent !== values[index][1],
      )
    )
      select.replaceChildren(
        ...Array.from(select.children).filter(
          (child) => child.localName === 'button',
        ),
        ...values.map(([value, text]) => {
          const option = document.createElement('option');
          option.value = value;
          option.textContent = text;
          return option;
        }),
      );
    if (select.value !== (selected || '')) select.value = selected || '';
  }
  async function read(request, maxDimension) {
    let deliveryRetried = false;
    let response = await app.callServerTool(
      {
        name: 'figma_canvas',
        arguments: {
          clientId: request.session.clientId,
          fileKey: request.fileKey,
          pageId: request.pageId,
          maxDimension,
        },
      },
      { timeout: 25000 },
    );
    // Follow the original receipt after a wait or delivery failure. Never
    // submit another native read merely because the first is still running.
    while (desired?.key === request.key) {
      const record = response.structuredContent,
        operationId = record?.operationId || record?.job?.id;
      if (record?.phase === 'delivery' && deliveryRetried)
        throw new Error(record.message || '画布预览未送达');
      if (
        operationId &&
        (['queued', 'running'].includes(record.job?.status) ||
          record.phase === 'delivery')
      ) {
        if (record.phase === 'delivery') deliveryRetried = true;
        response = await app.callServerTool(
          { name: 'figma_job', arguments: { operationId, waitMs: 20000 } },
          { timeout: 25000 },
        );
        continue;
      }
      if (response.isError || record?.job?.status !== 'succeeded')
        throw new Error(
          record?.message || record?.job?.error || '画布读取失败',
        );
      return response;
    }
  }
  async function refresh() {
    if (disposed) return;
    if (running) return;
    running = true;
    try {
      while (desired && desired.key !== handled) {
        const request = desired;
        handled = request.key;
        if (!geometry) message('正在读取画布…');
        $('viewer').setAttribute('aria-busy', 'true');
        try {
          let response, value, rendered;
          for (let dimension = 2048; dimension >= 256; dimension /= 2) {
            response = await read(request, dimension);
            if (desired?.key !== request.key) break;
            value = response.structuredContent.job.result.value;
            rendered = response.content?.find((item) => item.type === 'image');
            if (
              value.empty ||
              rendered ||
              !response.structuredContent.previewHint
            )
              break;
          }
          if (desired?.key !== request.key) continue;
          if (value.page.id !== request.pageId)
            throw new Error('返回的页面与所选页面不一致');
          options(
            pages,
            value.pages.map((page) => [page.id, page.name]),
            value.page.id,
          );
          pages.disabled = false;
          const background = value.backgrounds?.find(
            (paint) => paint.type === 'SOLID' && paint.visible !== false,
          );
          if (value.empty) {
            clear();
            message('此页面没有可见内容');
          } else {
            if (!rendered) throw new Error('画布预览未送达');
            const decoded = document.createElement('img');
            decoded.src = `data:${rendered.mimeType};base64,${rendered.data}`;
            await decoded.decode();
            if (desired?.key !== request.key) continue;
            const first = !geometry,
              restored = !!restoration;
            if (geometry && !fitted) {
              position.x += (value.bounds.x - geometry.x) * position.scale;
              position.y += (value.bounds.y - geometry.y) * position.scale;
            }
            geometry = {
              x: value.bounds.x,
              y: value.bounds.y,
              width: decoded.naturalWidth / value.scale,
              height: decoded.naturalHeight / value.scale,
            };
            if (restoration) {
              Object.assign(position, restoration.position);
              if (restoration.geometry) {
                position.x +=
                  (geometry.x - restoration.geometry.x) * position.scale;
                position.y +=
                  (geometry.y - restoration.geometry.y) * position.scale;
              }
              fitted = restoration.fitted;
              restoration = undefined;
            }
            image.src = decoded.src;
            image.style.width = `${geometry.width}px`;
            image.style.height = `${geometry.height}px`;
            image.hidden = false;
            $('canvas-zoom').disabled = $('canvas-fit').disabled = false;
            $('canvas-minus').disabled = $('canvas-plus').disabled = false;
            if (fitted || (first && !restored)) fit();
            else paint();
            message();
          }
          if (background)
            viewport.style.background = `rgb(${background.color.r * 255} ${background.color.g * 255} ${background.color.b * 255} / ${background.opacity ?? 1})`;
          context({
            clientId: request.session.clientId,
            pageId: value.page.id,
            pageName: value.page.name,
            revision: value.revision,
          });
        } catch (error) {
          if (desired?.key === request.key) {
            if (!geometry) clear();
            message(error.message, true);
          }
        }
      }
    } finally {
      running = false;
      if (!disposed) $('viewer').setAttribute('aria-busy', String(writing));
    }
  }
  function update(nextFile, nextAccountId) {
    if (disposed) return;
    const identity = nextFile && `${nextAccountId}:${nextFile.fileKey}`;
    if (identity !== fileIdentity) {
      fileIdentity = identity;
      viewportIdentity = undefined;
      target = null;
      clientId = pageId = undefined;
      handled = undefined;
      options(pages, []);
      clear();
    }
    file = nextFile;
    accountId = nextAccountId;
    if (restoration) {
      if (restoration.fileIdentity !== identity) restoration = undefined;
      else {
        clientId = restoration.target?.clientId;
        pageId = restoration.target?.pageId;
      }
    }
    const candidates = file?.sessions || [],
      session =
        candidates.find((item) => item.clientId === clientId) ||
        (candidates.length === 1 ? candidates[0] : null);
    options(
      sessions,
      [
        ['', '选择 Figma 实例'],
        ...candidates.map((item) => [
          item.clientId,
          `${item.pageName} · ${item.instanceId}`,
        ]),
      ],
      session?.clientId,
    );
    sessions.hidden = candidates.length <= 1;
    $('canvas-toolbar').hidden = !file;
    if (!session) {
      writing = false;
      target = null;
      viewportIdentity = undefined;
      desired = undefined;
      handled = undefined;
      pages.disabled = true;
      clear();
      $('viewer').setAttribute('aria-busy', 'false');
      message(
        !file
          ? ''
          : candidates.length
            ? '选择要预览的 Figma 实例'
            : '等待 Figma 桌面端连接',
      );
      return;
    }
    const targetPage = pageId || session.pageId,
      targetIdentity = JSON.stringify([
        identity,
        session.clientId,
        session.instanceId,
        targetPage,
      ]);
    target = { clientId: session.clientId, pageId: targetPage };
    if (targetIdentity !== viewportIdentity) {
      viewportIdentity = targetIdentity;
      handled = undefined;
      pages.disabled = true;
      clear();
    }
    writing = !!session.writing;
    if (writing) {
      desired = handled = undefined;
      $('viewer').setAttribute('aria-busy', 'true');
      if (!geometry) message('正在更新设计…');
      return;
    }
    const key = JSON.stringify([targetIdentity, session.documentRevision]);
    desired = { key, fileKey: file.fileKey, session, pageId: targetPage };
    void refresh();
  }
  pages.onchange = () => {
    pageId = pages.value;
    update(file, accountId);
  };
  sessions.onchange = () => {
    clientId = sessions.value;
    pageId = undefined;
    update(file, accountId);
  };
  retry.onclick = () => {
    handled = undefined;
    void refresh();
  };
  return {
    update,
    navigate(value) {
      restoration = value;
    },
    dispose() {
      disposed = true;
      desired = undefined;
      observer.disconnect();
    },
    get state() {
      return {
        fileIdentity,
        target,
        position: { ...position },
        geometry,
        fitted,
      };
    },
    get context() {
      return preview;
    },
    get target() {
      return target;
    },
  };
}
