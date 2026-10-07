// Shared native runtime contract. No design snapshot dependencies.
const BRIDGE_RUNTIME_VERSION = 20;
const BRIDGE_PROTOCOL_VERSION = 3;
function formatBridgeError(error) {
  if (
    error &&
    typeof error === 'object' &&
    typeof error.message === 'string' &&
    error.message
  ) {
    return error.message;
  }
  return String(error);
}
function validArtifactName(name) {
  return (
    typeof name === 'string' &&
    name.length <= 120 &&
    /^[\p{L}\p{N}][\p{L}\p{M}\p{N}._ -]*$/u.test(name)
  );
}

if (typeof module !== 'undefined')
  module.exports = {
    BRIDGE_RUNTIME_VERSION,
    BRIDGE_PROTOCOL_VERSION,
    formatBridgeError,
    validArtifactName,
  };
