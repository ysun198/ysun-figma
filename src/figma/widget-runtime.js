// A real Widget entrypoint. Definitions are trusted local source, never code
// loaded from multiplayer synced state. All hooks run in the actual render.
/* global YSUN_WIDGET_RENDER */
/* exported startWidgetPlugin */
function startWidgetPlugin() {
  const widget = figma.widget;
  let started = false;
  function DefaultWidget() {
    const [label] = widget.useSyncedState('label', 'ysun figma · Widget API');
    const [count, setCount] = widget.useSyncedState('count', 0);
    return widget.h(
      widget.AutoLayout,
      {
        direction: 'vertical',
        padding: 20,
        spacing: 12,
        fill: '#FFFFFF',
        stroke: '#D8DFED',
        cornerRadius: 12,
      },
      widget.h(widget.Text, { fontSize: 16 }, label),
      widget.h(
        widget.Text,
        { fontSize: 28, onClick: () => setCount(count + 1) },
        String(count),
      ),
    );
  }
  widget.register(function YsunWidget() {
    widget.useEffect(() => {
      if (!started) {
        started = true;
        startNativePlugin();
        widget.waitForTask(new Promise(() => {}));
      }
    });
    return (
      typeof YSUN_WIDGET_RENDER === 'function'
        ? YSUN_WIDGET_RENDER
        : DefaultWidget
    )();
  });
}
