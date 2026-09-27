import * as THREE from 'three';
import type { Visual } from '@gaime/core';
import { Interpolator, ServerClock } from '@gaime/core/client';
import { CAMERA, CameraRig, createLabel, createStage, EntityLayer, ModelLibrary, type Stage } from '@gaime/core/three';
import type { Input, Pickup, Player, World } from '../shared/types';
import { movePlayer, RULES } from '../shared/rules';

/** Everything 3D: ground, players (others interpolated, you predicted), pickups. */
export class Scene {
  readonly stage: Stage;
  private readonly rig: CameraRig;
  private readonly clock = new ServerClock();
  private readonly tracks = new Interpolator();
  private readonly models = new ModelLibrary();
  private readonly players: EntityLayer<Player>;
  private readonly pickups: EntityLayer<Pickup>;
  private world?: World;
  private local?: { x: number; z: number };
  meId = '';
  input?: Input;

  constructor(container: HTMLElement) {
    this.stage = createStage({ container, background: '#0b0f14' });
    this.rig = new CameraRig(this.stage.camera, { offset: CAMERA.topDown });
    const { scene } = this.stage;
    scene.add(new THREE.HemisphereLight('#cfe3ff', '#1a1410', 1.2));
    const sun = new THREE.DirectionalLight('#ffffff', 2);
    sun.position.set(10, 25, 12);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -25, right: 25, top: 25, bottom: -25 });
    scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(RULES.size, RULES.size).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#1d2733' }));
    ground.receiveShadow = true;
    const grid = new THREE.GridHelper(RULES.size, RULES.size / 2, '#2e3d4f', '#263241');
    grid.position.y = 0.01;
    scene.add(ground, grid);

    this.players = new EntityLayer<Player>(scene, player => {
      const root = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 0.8, 6, 16), new THREE.MeshStandardMaterial({ color: player.color }));
      body.position.y = 0.8;
      body.castShadow = true;
      const label = createLabel(player.name, { background: 'rgba(0,0,0,0.45)' });
      label.position.y = 2.1;
      root.add(body, label);
      return root;
    }, player => `${player.color}:${player.name}`);
    this.pickups = new EntityLayer<Pickup>(scene, pickup => {
      const entry = this.world?.catalog.find(e => e.kind === 'pickups' && e.id === pickup.kind);
      return this.models.build((entry?.visual as Visual | undefined) ?? { shape: 'sphere', color: '#ffffff' });
    }, pickup => pickup.kind);
    this.stage.onFrame(dt => this.frame(dt));
  }

  update(world: World) {
    this.world = world;
    this.clock.sync(world.time);
    for (const player of Object.values(world.players)) this.tracks.push(player.id, world.time, { x: player.x, z: player.z });
    this.players.sync(Object.values(world.players).filter(player => player.online));
    this.pickups.sync(Object.values(world.pickups));
    const me = world.players[this.meId];
    if (!me) { this.local = undefined; return; }
    // Predict our own movement; drift back towards the server gently, snap when far off.
    if (!this.local || Math.hypot(this.local.x - me.x, this.local.z - me.z) > 2) this.local = { x: me.x, z: me.z };
    else { this.local.x += (me.x - this.local.x) * 0.1; this.local.z += (me.z - this.local.z) * 0.1; }
  }

  private frame(dt: number) {
    if (!this.world) return;
    if (this.local && this.input) movePlayer(this.local, this.input, dt);
    const renderTime = this.clock.now(0.1);
    this.players.forEach((object, player) => {
      const at = player.id === this.meId && this.local ? this.local : this.tracks.sample(player.id, renderTime) ?? player;
      object.position.set(at.x, 0, at.z);
    });
    this.pickups.forEach((object, pickup) => {
      object.position.set(pickup.x, 0, pickup.z);
      object.rotation.y += dt * 2;
    });
    this.rig.update(this.local ?? { x: 0, z: 0 }, dt);
  }

  dispose() {
    this.players.dispose();
    this.pickups.dispose();
    this.stage.dispose();
  }
}
