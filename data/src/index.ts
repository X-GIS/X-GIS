// @xgis/data public barrel. The tile data + loader layer (tile selection / catalog /
// types / SSE loading + the geometry helpers those need), extracted from runtime/src so
// @xgis/map (rendering) depends on it rather than owning it (SRP: data ≠ rendering).
export {}
