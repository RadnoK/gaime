import * as THREE from 'three';
import { Interpolator, ServerClock } from '@gaime/core/client';
import { CAMERA, CameraRig, createBar, createLabel, createStage, EffectsLayer, EntityLayer, faceCamera, setBar, setLabel, type Bar, type Stage } from '@gaime/core/three';
import type { Player, Projectile, World } from '../shared/types';
import { muzzle, RULES } from '../shared/rules';
import { fightersOf } from './util';

/** Side view: simulation x → scene X, simulation z (height) → scene Y. */
const at = (x: number, z: number, y = 0) => new THREE.Vector3(x, z + y, 0.5);

export class Battlefield {
  readonly stage: Stage;
  readonly rig: CameraRig;
  private readonly clock = new ServerClock();
  private readonly tracks = new Interpolator(['aim']);
  private readonly players: EntityLayer<Player>;
  private readonly shells: EntityLayer<Projectile>;
  private readonly effects: EffectsLayer;
  private terrain?: THREE.Mesh;
  private terrainSource?: number[];
  private readonly preview: THREE.Line;
  private world?: World;
  meId = '';
  /** Locally predicted aim of our own player (degrees). */
  localAim?: number;
  /** 0..1 while charging a shot, for the trajectory preview. */
  charge = 0;

  constructor(container: HTMLElement) {
    this.stage = createStage({ container, background: '#15212e' });
    this.rig = new CameraRig(this.stage.camera, { offset: CAMERA.side, lookOffset: { x: 0, y: 5, z: 0 }, damping: 3 });
    const { scene } = this.stage;
    scene.fog = new THREE.Fog('#15212e', 50, 110);
    scene.add(new THREE.HemisphereLight('#d7e8ff', '#302418', 1.3));
    const sun = new THREE.DirectionalLight('#fff4e0', 2);
    sun.position.set(-20, 40, 30);
    scene.add(sun);
    // Far hills for depth.
    const far = new THREE.Mesh(new THREE.PlaneGeometry(320, 24), new THREE.MeshBasicMaterial({ color: '#1b2938' }));
    far.position.set(0, -4, -30);
    scene.add(far);

    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: '#ffffff', dashSize: 0.4, gapSize: 0.4, transparent: true, opacity: 0.6 }));
    scene.add(this.preview);
    this.effects = new EffectsLayer(scene, { project: (x, z, y) => at(x, z, y) });
    this.players = new EntityLayer<Player>(scene, player => this.createPlayer(player), player => String(player.seat));
    this.shells = new EntityLayer<Projectile>(scene, shell => {
      const color = (this.world?.catalog.find(e => e.kind === 'weapons' && e.id === shell.kind)?.color as string | undefined) ?? '#ffffff';
      return new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 8), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6 }));
    }, shell => shell.kind);
    this.stage.onFrame(dt => this.frame(dt));
  }

  private createPlayer(player: Player) {
    const root = new THREE.Group();
    const color: string = player.seat === 0 || player.seat === 1 ? RULES.colors[player.seat] : '#888888';
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.45, 0.7, 6, 14), new THREE.MeshStandardMaterial({ color }));
    body.position.y = 0.8;
    const pivot = new THREE.Group();
    pivot.name = 'pivot';
    pivot.position.y = 1;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.2, 10).translate(0, 0.6, 0), new THREE.MeshStandardMaterial({ color: '#d9e1ea' }));
    pivot.add(barrel);
    const label = createLabel(player.name, { background: 'rgba(0,0,0,0.45)', size: 0.55 });
    label.name = 'label';
    label.position.y = 2.7;
    const bar = createBar(1.4, color);
    bar.name = 'bar';
    bar.position.y = 2.2;
    root.add(body, pivot, label, bar);
    return root;
  }

  private rebuildTerrain(heights: number[]) {
    this.terrainSource = heights;
    if (this.terrain) { this.stage.scene.remove(this.terrain); this.terrain.geometry.dispose(); }
    const shape = new THREE.Shape();
    shape.moveTo(-RULES.width / 2 - 20, -14);
    shape.lineTo(-RULES.width / 2 - 20, heights[0]);
    heights.forEach((h, i) => shape.lineTo(-RULES.width / 2 + i * RULES.step, h));
    shape.lineTo(RULES.width / 2 + 20, heights.at(-1)!);
    shape.lineTo(RULES.width / 2 + 20, -14);
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: 8, bevelEnabled: false }).translate(0, 0, -4);
    this.terrain ??= new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#5a7a3a', roughness: 1, flatShading: true }));
    this.terrain.geometry = geometry;
    this.stage.scene.add(this.terrain);
  }

  update(world: World) {
    this.world = world;
    this.clock.sync(world.time);
    if (world.terrain !== this.terrainSource) this.rebuildTerrain(world.terrain);
    for (const player of Object.values(world.players)) this.tracks.push(player.id, world.time, { x: player.x, z: player.z, aim: player.aim });
    for (const shell of Object.values(world.projectiles)) this.tracks.push(shell.id, world.time, { x: shell.x, z: shell.z });
    this.tracks.retain([...Object.keys(world.players), ...Object.keys(world.projectiles)]);
    this.players.sync(fightersOf(world));
    this.shells.sync(Object.values(world.projectiles));
    this.effects.sync(world.effects);
  }

  private frame(dt: number) {
    const world = this.world;
    if (!world) return;
    const time = this.clock.now(0.1);
    const camera = this.stage.camera;
    const positions: THREE.Vector3[] = [];
    this.players.forEach((object, player) => {
      const sample = this.tracks.sample(player.id, time) ?? player;
      const aim = player.id === this.meId && this.localAim !== undefined ? this.localAim : sample.aim;
      object.position.copy(at(sample.x, sample.z)).setZ(0);
      object.getObjectByName('pivot')!.rotation.z = ((aim - 90) * Math.PI) / 180;
      object.visible = player.hp > 0 || world.match.phase !== 'playing';
      setLabel(object.getObjectByName('label') as THREE.Sprite, `${world.hostId === player.id ? '👑 ' : ''}${player.data['gaime-bot'] ? '🤖 ' : ''}${player.name}`);
      const bar = object.getObjectByName('bar') as Bar;
      setBar(bar, player.hp / RULES.hp);
      faceCamera(bar, camera);
      positions.push(object.position);
    });
    const flying: THREE.Vector3[] = [];
    this.shells.forEach((object, shell) => {
      const sample = this.tracks.sample(shell.id, time) ?? shell;
      object.position.copy(at(sample.x, sample.z));
      flying.push(object.position);
    });
    this.effects.update(time);
    this.drawPreview(world);

    // Frame both fighters and every shell in flight.
    const points = [...positions, ...flying];
    if (points.length) {
      const box = new THREE.Box3().setFromPoints(points);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      this.rig.setOffset({ x: 0, y: 3, z: Math.max(24, size.x * 0.75 + 12, size.y * 1.4 + 12) });
      this.rig.update({ x: center.x, z: 0, y: center.y }, dt);
    }
  }

  /** Dashed arc of the shot you are about to fire (ignores wind — that is the skill). */
  private drawPreview(world: World) {
    const me = world.players[this.meId];
    const turns = world.turns;
    const active = me && turns && turns.order[turns.index] === me.id && world.turnPhase === 'aim' && world.match.phase === 'playing';
    this.preview.visible = !!active;
    if (!active) return;
    const weapon = world.catalog.find(e => e.kind === 'weapons' && e.id === me.weapon);
    const aim = this.localAim ?? me.aim;
    const speed = Number(weapon?.speed ?? 38) * Math.max(0.15, this.charge || 0.6);
    const gravity = RULES.gravity * Number(weapon?.gravity ?? 1);
    const start = muzzle(me, aim);
    const radians = (aim * Math.PI) / 180;
    const points: THREE.Vector3[] = [];
    for (let t = 0; t < 1.2; t += 0.05) points.push(at(start.x + Math.cos(radians) * speed * t, start.z + Math.sin(radians) * speed * t - 0.5 * gravity * t * t));
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(points);
    this.preview.computeLineDistances();
  }

  dispose() {
    this.players.dispose();
    this.shells.dispose();
    this.effects.dispose();
    this.preview.geometry.dispose();
    this.stage.dispose();
  }
}
