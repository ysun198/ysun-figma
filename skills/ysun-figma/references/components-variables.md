# Components, variables and styles

Query `ComponentNode`, `ComponentSetNode`, `InstanceNode`, `ComponentPropertiesMixin`, `VariablesAPI`, `VariableCollection`, `Variable`, and the relevant style interface. Reuse the file's actual assets and requested scope; a single edit does not imply creating a new design system.

## Components and instances

Use `figma_design_system`/`figma_components` to resolve exact assets, then inspect selected IDs. `createComponentFromNode` converts an existing node; `createComponent` constructs a new master; `combineAsVariants` creates a component set. Keep real instances connected to their masters instead of cloning/detaching them just to change a supported property.

```js
const instance = await figma.getNodeByIdAsync(args.instanceId);
if (!instance || instance.type !== 'INSTANCE') throw new Error('Expected instance');
const main = await instance.getMainComponentAsync();
if (!main) throw new Error('Main component unavailable');
const owner = main.parent?.type === 'COMPONENT_SET' ? main.parent : main;
return { instanceId: instance.id, mainId: main.id, ownerId: owner.id,
  definitions: owner.componentPropertyDefinitions,
  values: instance.componentProperties };
```

Read property definitions from the owning component/set, not a variant. Property keys may include stable IDs after `#`; use the returned keys for mutations and use the new ID returned by a rename. `setProperties` updates TEXT, BOOLEAN, INSTANCE_SWAP and VARIANT properties; `swapComponent` switches the master and `resetOverrides` removes overrides deliberately.

For an editable content area, use native slots. `component.createSlot()` creates the slot and its property together; `slot.componentPropertyReferences.slotContentId` identifies that property. Configure its description/limits with `editComponentProperty`. In an instance, append/remove children on the actual SLOT node and use `resetSlot()` to restore default content. `instance.setProperties` rejects SLOT values. Slot frames do not support GRID layout. See the [official slot guide](https://developers.figma.com/docs/plugins/working-with-component-properties/#add-slot-properties) and query `SlotSettings` for exact limits.

Keep component-property references on the appropriate child layer. Load text fonts before changing a bound text layer. Bulk discovery should return IDs/names/types/counts, then fetch detailed definitions for the selected assets; do not serialize every property bundle across the whole file.

Published imports use verified `importComponentByKeyAsync`, `importComponentSetByKeyAsync`, `importStyleByKeyAsync` and variable keys. Native enabled-variable-library discovery does not enumerate every component library available to the account. A layer name is not a published key.

## Variables

```js
const collection = figma.variables.createVariableCollection(args.collectionName);
const variable = figma.variables.createVariable(args.variableName, collection, args.resolvedType);
variable.scopes = args.scopes;
variable.setValueForMode(collection.defaultModeId, args.value);
return { collectionId: collection.id, modeId: collection.defaultModeId, variableId: variable.id };
```

Use the actual supported resolved type and value shape. Modes are collection-specific; do not reuse a mode ID from a different collection. `createVariableAlias` links a variable instead of copying its literal. Preserve explicit/inherited modes and `resolvedVariableModes` when diagnosing a binding.

Bindings on nodes use `setBoundVariable`. Paint/effect/layout-grid binding helpers return a new value: clone the paint/effect/grid, capture the helper return and reassign the owning array. Binding only a detached copy has no effect. A property must support the variable type; consult the signature rather than assuming every text or style field uses the same setter.

Set scopes for intended picker visibility. Scopes control discoverability rather than access permission. Set code syntax only for the requested platform naming; do not manufacture a naming system when source conventions exist.

## Shared styles

Paint, text, effect, grid and custom animation styles are separate native types. Read current style IDs before replacing them with literals. Create/update the requested style, then apply it with the appropriate async node setter. Load the exact fonts before text-style changes.

Verify representative instances across requested variants and modes. Return actual property values, bindings and style IDs, plus a native render where appearance matters. Creating a collection, component set or style without applying its intended binding does not complete the requested behavior.
