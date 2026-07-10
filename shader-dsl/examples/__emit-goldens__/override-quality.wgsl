override quality: f32 = 1.0;

fn shade(base: f32) -> f32 {
  var _v0: f32 = base;
  if ((quality > 1.0)) {
    _v0 = ((_v0 * 2.0) + 0.5);
  }
  return _v0;
}
