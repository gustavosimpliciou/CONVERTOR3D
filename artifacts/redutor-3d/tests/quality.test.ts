import assert from 'node:assert/strict';
import { BoxGeometry, SphereGeometry } from 'three';
import { meshFromTriangleCoordinates, normalizeTriangles } from '../src/lib/mesh/geometry';
import { targetFacesToKeep } from '../src/lib/mesh/processor';
import { reduceStlQuality as simplifyMesh, disconnectedVertexFans } from '../src/lib/mesh/quality-reducer';
import { auditMesh } from '../src/lib/mesh/validation';
import { exportBinaryStl } from '../src/lib/mesh/stl';
import { parseMesh } from '../src/lib/mesh/parser';
(async()=>{
assert.equal(targetFacesToKeep(2_000_000,10),200_000);
assert.equal(targetFacesToKeep(2_000_000,100),2_000_000);
assert.equal(targetFacesToKeep(2_000_000,0.2),4000);
assert.throws(()=>targetFacesToKeep(2000,NaN));
const touching = new Uint32Array([0,1,2, 0,2,3, 0,3,1, 1,3,2, 0,4,5, 0,5,6, 0,6,4, 4,6,5]);
assert.deepEqual([...disconnectedVertexFans(touching, 7)], [0], 'Two surfaces meeting only at a vertex must be detected');
const tiny = meshFromTriangleCoordinates(new Float32Array([0,0,0, 1e-8,0,0, 0,1e-8,0]));
assert.equal(tiny.indices.length, 3);
const tinyStl = exportBinaryStl(tiny);
assert(tinyStl.valid, 'A tiny nonzero-area STL facet must remain valid');
assert.equal(parseMesh(tinyStl.buffer, 'tiny.stl').indices.length, 3);
function fromGeometry(g:any){ const p=Array.from(g.attributes.position.array) as number[];const ind=Array.from(g.index.array) as number[];const faces=[];for(let i=0;i<ind.length;i+=3)faces.push(ind.slice(i,i+3));return normalizeTriangles(p,faces,'STL'); }
for(const [name,g] of [['subdivided-box',new BoxGeometry(10,10,10,10,10,10)],['sphere',new SphereGeometry(10,32,24)]] as const){
 const mesh=fromGeometry(g);const before=auditMesh(mesh);assert.equal(before.nonManifoldEdges,0);
 const result=await simplifyMesh(mesh,{targetTriangles:Math.floor(mesh.indices.length/30),quality:'ultra',profile:'quality',preserveBorders:true,preserveSilhouette:true,protectDetails:true,timeBudgetMs:20000,limits:{maxMeanError:.00025,maxMaxError:.0005,maxVolumeError:.5}});
 assert.equal(result.report.effectiveProfile,'quality');assert.equal(result.report.escalations,0);assert(result.validation.qualityAccepted);assert.equal(result.validation.nonManifoldEdges,0);assert.equal(result.validation.boundaryLoops,0);
 assert.equal(result.positions.length / 3 - result.indices.length / 6, mesh.positions.length / 3 - mesh.indices.length / 6, 'Closed-surface Euler characteristic must remain unchanged');assert(result.report.maxError<=.0005);assert(result.report.volumeDeltaPercent<=.5);
 const output=exportBinaryStl({...mesh,positions:result.positions,indices:result.indices});assert(output.valid);const rt=parseMesh(output.buffer,'roundtrip.stl');const after=auditMesh(rt,before);assert(after.valid,after.reasons.join(';'));assert.equal(rt.indices.length,result.indices.length);
 console.log(JSON.stringify({name,original:mesh.indices.length/3,output:result.triangles,stop:result.report.stoppedReason,maxError:result.report.maxError,volume:result.report.volumeDeltaPercent}));
 if(name==='subdivided-box')assert(result.triangles<mesh.indices.length/3,'Flat subdivisions should simplify');
}
console.log('Safety regression checks passed');

})().catch(e=>{console.error(e);process.exitCode=1;});
