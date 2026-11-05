function createMotionQueries({
  describe,
  figma,
  findNodes,
  identity,
  issues,
  read,
  safe,
}) {
  async function motion(args = {}) {
    const rootId = args.nodeId || args.rootId;
    const populated = (value) =>
      Array.isArray(value)
        ? value.length > 0
        : !!(value && Object.keys(value).length);
    const found = await findNodes(
      {
        ...args,
        rootId,
        query: '',
        limit: args.maxNodes ?? 200,
      },
      (node) => {
        const data = read(node, [
          'animations',
          'manualKeyframeTracks',
          'animationStyles',
          'timelines',
          'reactions',
        ]);
        const hasMotion = [
          'animations',
          'manualKeyframeTracks',
          'animationStyles',
        ].some((key) => populated(data[key]));
        const hasPrototype = populated(data.reactions);
        return hasMotion ||
          hasPrototype ||
          (populated(data.timelines) &&
            (args.includeStaticTimelines || node.id === rootId))
          ? { ...describe(node), ...data, hasMotion, hasPrototype }
          : null;
      },
    );
    let availableStyles = [];
    try {
      availableStyles = safe(figma.motion.figmaAnimationStyles());
    } catch (error) {
      issues.push({
        field: 'motion',
        error: String(error.message || error).slice(0, 200),
      });
    }
    return {
      file: identity(),
      nodes: found.nodes,
      motionNodeCount: found.nodes.filter((node) => node?.hasMotion).length,
      prototypeNodeCount: found.nodes.filter((node) => node?.hasPrototype)
        .length,
      timelineOnlyNodeCount: found.nodes.filter(
        (node) =>
          node &&
          !node.hasMotion &&
          !node.hasPrototype &&
          node.timelines?.length,
      ).length,
      availableStyles,
      cursor: found.cursor,
      truncated: found.truncated,
      issues: issues.slice(0, 100),
      units:
        'Native timeline seconds; easing and typed values are returned without guessed code conversion.',
    };
  }
  return { motion };
}
module.exports = { createMotionQueries };
