function newer(a, b) {
  if (![a, b].every((v) => /^\d+\.\d+\.\d+$/.test(v)))
    throw new Error('Invalid release version');
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  const i = left.findIndex((n, j) => n !== right[j]);
  return i >= 0 && left[i] > right[i];
}
module.exports = { newer };
