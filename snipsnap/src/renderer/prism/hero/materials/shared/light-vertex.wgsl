// Static light-ribbon attributes decoded from the retained global vertex
// index. The CPU uploads only position.xy and intensity; vertex counts and
// first-vertex ranges remain identical to the original interleaved mesh.

const QUAD_UPPER = array<u32, 6>(0u, 1u, 1u, 0u, 1u, 0u);
const QUAD_END_TRAVEL = array<f32, 6>(0.0, 0.0, 1.0, 0.0, 1.0, 1.0);

// Exact Float32 results of `-1 + 2 * boundary / 24` from the CPU mesh.
const BEAM_BOUNDARY_PROFILES = array<f32, 25>(
  -1.0, -0.9166666865348816, -0.8333333134651184, -0.75,
  -0.6666666865348816, -0.5833333134651184, -0.5,
  -0.4166666567325592, -0.3333333432674408, -0.25,
  -0.1666666716337204, -0.0833333358168602, 0.0,
  0.0833333358168602, 0.1666666716337204, 0.25,
  0.3333333432674408, 0.4166666567325592, 0.5,
  0.5833333134651184, 0.6666666865348816, 0.75,
  0.8333333134651184, 0.9166666865348816, 1.0,
);

export struct LightVertexMetadata {
  profile: f32,
  travel: f32,
  spectralIndex: u32,
  white: u32,
  revealProfile: f32,
}

export fn decodeLightVertex(
  vertexIndex: u32,
  whiteQuads: u32,
  beamSlices: u32,
  internalQuads: u32,
  internalSegments: u32,
) -> LightVertexMetadata {
  let quad = vertexIndex / 6u;
  let corner = vertexIndex % 6u;
  let upper = QUAD_UPPER[corner];

  if quad < whiteQuads {
    return LightVertexMetadata(
      BEAM_BOUNDARY_PROFILES[quad + upper],
      0.0,
      0u,
      1u,
      BEAM_BOUNDARY_PROFILES[quad + upper],
    );
  }

  let spectralQuad = quad - whiteQuads;
  if spectralQuad < internalQuads {
    let quadsPerWavelength = beamSlices * internalSegments;
    let spectralIndex = spectralQuad / quadsPerWavelength;
    let slice = (spectralQuad % quadsPerWavelength) / internalSegments;
    return LightVertexMetadata(
      BEAM_BOUNDARY_PROFILES[slice + upper],
      0.0,
      spectralIndex,
      0u,
      BEAM_BOUNDARY_PROFILES[slice + upper],
    );
  }

  let outgoingQuad = spectralQuad - internalQuads;
  let outgoingSlice = outgoingQuad % beamSlices;
  return LightVertexMetadata(
    0.0,
    QUAD_END_TRAVEL[corner],
    outgoingQuad / beamSlices + upper,
    0u,
    0.5 * (
      BEAM_BOUNDARY_PROFILES[outgoingSlice]
        + BEAM_BOUNDARY_PROFILES[outgoingSlice + 1u]
    ),
  );
}
