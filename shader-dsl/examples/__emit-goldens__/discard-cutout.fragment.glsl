#version 300 es
precision highp float;
precision highp int;

struct VsOut {
  vec4 pos;
  vec2 uv;
};

struct FsOut {
  vec4 color;
};
layout(std140) uniform Uniforms {
  float time;
  vec2 resolution;
} U;
vec4 discard_outside_circle(vec2 p) {
  float _v0 = length(p);
  if ((_v0 > 1.0)) {
    discard;
  }
  return vec4(mix(vec3(1.0, 1.0, 1.0), vec3(0.06, 0.1, 0.35), _v0), 1.0);
}
in vec2 uv;
layout(location = 0) out vec4 color;

void main() {
  VsOut vo;
  vo.pos = gl_FragCoord;
  vo.uv = uv;
  vec4 _dh0 = discard_outside_circle(vec2((((vo.uv.x * 2.0) - 1.0) * (U.resolution.x / U.resolution.y)), ((vo.uv.y * 2.0) - 1.0)));
  FsOut _out = FsOut(_dh0);
  color = _out.color;
}
