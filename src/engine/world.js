/**
 * Rigid-body world — bit-exact port of class `Er` from the quip.gg bundle.
 *
 * Integration order per step (this order matters for determinism):
 *   1. for every body: clear `hit`, apply drag to velocity, integrate position
 *   2. for every unordered pair: resolve overlap + restitution impulse
 */

import { ONE, fmul, fdiv, isqrt } from './fixed.js';

export const BODY_STRIDE = 4; // px, pz, vx, vz

export class World {
  constructor() {
    this.bodies = [];
    this.nextId = 0;
  }

  addBody({ px, pz, radius, invMass, restitution, drag }) {
    const b = {
      id: this.nextId++,
      px,
      pz,
      vx: 0,
      vz: 0,
      radius,
      invMass,
      restitution,
      drag,
      hit: false,
    };
    this.bodies.push(b);
    return b;
  }

  static accelerate(b, ax, az) {
    b.vx += ax;
    b.vz += az;
  }

  static applyImpulse(b, ix, iz) {
    b.vx += fmul(ix, b.invMass);
    b.vz += fmul(iz, b.invMass);
  }

  step() {
    const bodies = this.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i];
      b.hit = false;
      if (b.invMass !== 0) {
        b.vx = fmul(b.vx, b.drag);
        b.vz = fmul(b.vz, b.drag);
        b.px += b.vx;
        b.pz += b.vz;
      }
    }
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        this.resolvePair(bodies[i], bodies[j]);
      }
    }
  }

  resolvePair(a, b) {
    const invSum = a.invMass + b.invMass;
    if (invSum === 0) return;

    const dx = b.px - a.px;
    const dz = b.pz - a.pz;
    const d2 = dx * dx + dz * dz;
    const rsum = a.radius + b.radius;
    if (d2 >= rsum * rsum) return;

    const dist = isqrt(d2);
    let nx;
    let nz;
    if (dist === 0) {
      nx = ONE;
      nz = 0;
    } else {
      nx = fdiv(dx, dist);
      nz = fdiv(dz, dist);
    }
    a.hit = true;
    b.hit = true;

    // Positional de-penetration, split by inverse mass.
    const pen = rsum - dist;
    const shareA = fdiv(a.invMass, invSum);
    const shareB = fdiv(b.invMass, invSum);
    const moveA = fmul(pen, shareA);
    const moveB = fmul(pen, shareB);
    a.px -= fmul(nx, moveA);
    a.pz -= fmul(nz, moveA);
    b.px += fmul(nx, moveB);
    b.pz += fmul(nz, moveB);

    // Normal impulse with the softer restitution of the pair.
    const rvx = b.vx - a.vx;
    const rvz = b.vz - a.vz;
    const vn = fmul(rvx, nx) + fmul(rvz, nz);
    if (vn > 0) return; // separating already

    const e = ONE + (a.restitution < b.restitution ? a.restitution : b.restitution);
    const j = fdiv(-fmul(e, vn), invSum);
    const jx = fmul(nx, j);
    const jz = fmul(nz, j);
    a.vx -= fmul(jx, a.invMass);
    a.vz -= fmul(jz, a.invMass);
    b.vx += fmul(jx, b.invMass);
    b.vz += fmul(jz, b.invMass);
  }

  packSize() {
    return this.bodies.length * BODY_STRIDE;
  }

  pack(out, offset) {
    let k = offset;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      out[k++] = b.px;
      out[k++] = b.pz;
      out[k++] = b.vx;
      out[k++] = b.vz;
    }
    return k;
  }

  unpack(src, offset) {
    let k = offset;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      b.px = src[k++];
      b.pz = src[k++];
      b.vx = src[k++];
      b.vz = src[k++];
      b.hit = false;
    }
    return k;
  }
}
