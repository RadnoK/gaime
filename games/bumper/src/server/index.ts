import { createGameServer } from '@gaime/core/server';
import { game } from './game';

export const server = createGameServer(game);
