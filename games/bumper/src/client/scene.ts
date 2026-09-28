import * as THREE from 'three';
import type { Visual } from '@gaime/core';
import { Interpolator, ServerClock } from '@gaime/core/client';
import { CameraRig, createLabel, createStage, EntityLayer, ModelLibrary, type Stage } from '@gaime/core/three';
import type { Pickup, Player, World } from '../shared/types';
import { dashLeft, powerupsOf, RULES } from '../shared/rules';

/** Seconds a knocked-out disc is shown falling. */
const FALL = 1.2;

/**
 * Top-down arena. Discs are physics bodies simulated on the server: every disc (yours too) is
 * interpolated between server states — no client prediction, so what you see is what the server did.
 */
export class Scene {
  readonly stage: Stage;
  readonly rig: CameraRig;
  private readonly clock = new ServerClock();
  private readonly tracks = new Interpolator(['angle']);
  private readonly models = new ModelLibrary();
  private readonly players: EntityLayer<Player>;
  private readonly pickups: EntityLayer<Pickup>;
  private readonly floor: THREE.Mesh;
  private readonly rim: THREE.Mesh;
  private world?: World;
  meId = '';

  constructor(container: HTMLElement) {
    this.stage = createStage({ container, background: '#07090d' });
    this.rig = new CameraRig(this.stage.camera, { offset: new THREE.Vector3(0, 24, 13), damping: 3 });
    const { scene } = this.stage;
    scene.add(new THREE.HemisphereLight('#cfe3ff', '#120d0a', 1.1));
    const sun = new THREE.DirectionalLight('#ffffff', 2.2);
    sun.position.set(8, 25, 10);
    sun.castShadow = true;
    Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16 });
    scene.add(sun);
    // A unit disc scaled to the current arena radius every frame.
    this.floor = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.6, 72), new THREE.MeshStandardMaterial({ color: '#1f2b3a', roughness: 0.8 }));
    this.floor.position.y = -0.3;
    this.floor.receiveShadow = true;
    this.rim = new THREE.Mesh(new THREE.RingGeometry(0.97, 1, 96).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ff5977' }));
    this.rim.position.y = 0.02;
    scene.add(this.floor, this.rim);

    this.players = new EntityLayer<Player>(scene, player => {
      const root = new THREE.Group();
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(RULES.radius, RULES.radius, 0.5, 40), new THREE.MeshStandardMaterial({ color: player.color, metalness: 0.2, roughness: 0.45 }));
      disc.position.y = 0.25;
      disc.castShadow = true;
      // A stripe shows the spin.
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(RULES.radius * 1.6, 0.52, 0.18), new THREE.MeshStandardMaterial({ color: '#ffffff' }));
      stripe.position.y = 0.25;
      const spinner = new THREE.Group();
      spinner.name = 'spinner';
      spinner.add(disc, stripe);
      const aura = new THREE.Mesh(new THREE.RingGeometry(RULES.radius + 0.1, RULES.radius + 0.28, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8 }));
      aura.name = 'aura';
      aura.position.y = 0.03;
      const label = createLabel(player.name, { background: 'rgba(0,0,0,0.45)' });
      label.position.y = 1.5;
      root.add(spinner, aura, label);
      return root;
    }, player => `${player.color}:${player.name}`);
    this.pickups = new EntityLayer<Pickup>(scene, pickup => {
      const entry = this.world?.catalog.find(e => e.kind === 'powerups' && e.id === pickup.kind);
      return this.models.build((entry?.visual as Visual | undefined) ?? { shape: 'sphere', color: '#ffffff' });
    }, pickup => pickup.kind);
    this.stage.onFrame(dt => this.frame(dt));
  }

  update(world: World) {
    this.world = world;
    this.clock.sync(world.time);
    for (const player of Object.values(world.players)) {
      if (player.alive) this.tracks.push(player.id, world.time, { x: player.x, z: player.z, angle: player.angle });
    }
    this.tracks.retain(Object.keys(world.players));
    // Discs on the arena, plus the ones still falling off it.
    this.players.sync(Object.values(world.players).filter(p => p.alive || world.time - p.outAt < FALL));
    this.pickups.sync(Object.values(world.pickups));
  }

  private frame(dt: number) {
    const world = this.world;
    if (!world) return;
    const renderTime = this.clock.now(0.1);
    const arena = world.arena;
    this.floor.scale.set(arena, 1, arena);
    this.rim.scale.set(arena, 1, arena);
    this.players.forEach((object, player) => {
      const at = this.tracks.sample(player.id, renderTime) ?? player;
      const falling = player.alive ? 0 : Math.max(0, renderTime - player.outAt);
      object.position.set(at.x, -9 * falling * falling, at.z);
      object.getObjectByName('spinner')!.rotation.y = -(at.angle ?? 0);
      // Aura: white while the dash recharges (you), the powerup color while one is active.
      const aura = object.getObjectByName('aura') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
      const powerup = powerupsOf(player, world.time)[0];
      const visual = powerup ? world.catalog.find(e => e.kind === 'powerups' && e.id === powerup)?.visual as Visual | undefined : undefined;
      const recharging = player.id === this.meId && dashLeft(player, world.time) > 0;
      aura.visible = player.alive && (!!visual || player.id === this.meId);
      aura.material.color.set(visual?.color ?? (recharging ? '#556070' : '#ffffff'));
      object.scale.setScalar(0.85 + Math.min(player.mass, 3) * 0.15);
    });
    this.pickups.forEach((object, pickup) => {
      object.position.set(pickup.x, 0.2 + Math.sin(renderTime * 3) * 0.1, pickup.z);
      object.rotation.y += dt * 2;
    });
    const me = world.players[this.meId];
    const focus = me?.alive ? this.tracks.sample(me.id, renderTime) ?? me : undefined;
    // Mostly the whole arena, drifting a little towards you.
    this.rig.update(focus ? { x: focus.x * 0.3, z: focus.z * 0.3 } : { x: 0, z: 0 }, dt);
  }

  dispose() {
    this.players.dispose();
    this.pickups.dispose();
    this.stage.dispose();
  }
}
