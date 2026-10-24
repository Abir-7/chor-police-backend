import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { RoomsService } from './rooms.service.js';
import type {
  CreateRoomPayload,
  JoinRoomPayload,
  KickPlayerPayload,
  ReclaimSeatPayload,
} from './room.types.js';

@WebSocketGateway({
  cors: {
    origin: '*', // Development only. Restrict this in production.
  },
})
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly activeSocketIds = new Map<string, string>();

  constructor(private readonly roomsService: RoomsService) {
    // A seat that stays empty past the grace period is released so the
    // remaining players are not blocked by a player who never returns.
    this.roomsService.setPlayerTimedOutHandler(
      (roomCode: string, playerName: string) => {
        const room = this.roomsService.getRoomIfExists(roomCode);

        if (room) {
          this.server
            .to(roomCode)
            .emit('room:updated', this.roomsService.getPublicState(room));
        }

        this.server.to(roomCode).emit('room:player-removed', {
          playerName,
          reason: 'timeout',
          message: `${playerName} did not come back in time and lost their seat.`,
        });
      },
    );
  }

  handleConnection(client: Socket): void {
    console.log(`Connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    const roomCode = client.data.roomCode as string | undefined;
    const playerId = client.data.playerId as string | undefined;

    if (!roomCode || !playerId) {
      return;
    }

    const playerKey = this.getPlayerKey(roomCode, playerId);
    const activeSocketId = this.activeSocketIds.get(playerKey);

    // Ignore disconnect events from an older connection.
    if (activeSocketId !== client.id) {
      return;
    }

    this.activeSocketIds.delete(playerKey);

    try {
      const room = this.roomsService.markPlayerDisconnected(roomCode, playerId);

      this.server
        .to(roomCode)
        .emit('room:updated', this.roomsService.getPublicState(room));
    } catch (error: unknown) {
      console.error('Failed to update disconnected player:', error);
    }
  }

  /**
   * Liveness probe. A phone that was locked can hold a "connected" socket that
   * is really dead; the client pings with an ack timeout on resume and
   * redials when this never answers.
   */
  @SubscribeMessage('app:ping')
  handlePing(): { ok: true; at: number } {
    return { ok: true, at: Date.now() };
  }

  @SubscribeMessage('room:create')
  handleCreateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: CreateRoomPayload,
  ): void {
    try {
      this.ensureNotInRoom(client, true);

      const { room, player, reconnectToken } = this.roomsService.createRoom(
        body?.playerName,
      );

      void client.join(room.code);
      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:created', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
        seatPin: player.seatPin,
      });

      console.log(`Room created: ${room.code}, host: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:join')
  handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: JoinRoomPayload,
  ): void {
    try {
      this.ensureNotInRoom(client);

      const { room, player, reconnectToken } = this.roomsService.joinRoom(
        body?.roomCode,
        body?.playerName,
      );

      void client.join(room.code);
      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:joined', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
        seatPin: player.seatPin,
      });

      this.server
        .to(room.code)
        .emit('room:updated', this.roomsService.getPublicState(room));

      console.log(`Player joined room ${room.code}: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:reconnect')
  handleReconnect(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    body: {
      roomCode: string;
      reconnectToken: string;
    },
  ): void {
    try {
      const { room, player, reconnectToken } =
        this.roomsService.reconnectPlayer(body?.roomCode, body?.reconnectToken);

      this.ensureSameSeat(client, player.id);

      void client.join(room.code);
      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:reconnected', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
        seatPin: player.seatPin,
      });

      this.server
        .to(room.code)
        .emit('room:updated', this.roomsService.getPublicState(room));

      // Only now that this socket is registered can the game state be synced
      // back to it, so the returning player lands on the live board.
      this.roomsService.notifyPlayerReconnected(room.code, player.id);

      console.log(`Player reconnected to room ${room.code}: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:reclaim')
  handleReclaimSeat(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ReclaimSeatPayload,
  ): void {
    try {
      const { room, player, reconnectToken } = this.roomsService.reclaimSeat(
        body?.roomCode,
        body?.playerName,
        body?.seatPin,
      );

      this.ensureSameSeat(client, player.id);

      void client.join(room.code);
      this.registerPlayerSocket(client, room.code, player.id);

      client.emit('room:reconnected', {
        ...this.roomsService.getPublicState(room),
        player: {
          id: player.id,
          name: player.name,
          isHost: player.isHost,
          isConnected: player.isConnected,
        },
        reconnectToken,
        seatPin: player.seatPin,
      });

      this.server
        .to(room.code)
        .emit('room:updated', this.roomsService.getPublicState(room));

      this.roomsService.notifyPlayerReconnected(room.code, player.id);

      console.log(`Seat reclaimed in room ${room.code}: ${player.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:add-bot')
  handleAddBot(
    @ConnectedSocket() client: Socket,
    @MessageBody() body?: { name?: string },
  ): void {
    try {
      const roomCode = client.data.roomCode as string | undefined;
      const playerId = client.data.playerId as string | undefined;

      if (!roomCode || !playerId) {
        throw new Error('You are not in a room.');
      }

      const { bot } = this.roomsService.addBotPlayer(
        roomCode,
        playerId,
        body?.name,
      );

      this.server
        .to(roomCode)
        .emit(
          'room:updated',
          this.roomsService.getPublicState(
            this.roomsService.getRoom(roomCode),
          ),
        );

      console.log(`Bot added to room ${roomCode}: ${bot.name}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:kick')
  handleKickPlayer(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: KickPlayerPayload,
  ): void {
    try {
      const roomCode = client.data.roomCode as string | undefined;
      const playerId = client.data.playerId as string | undefined;

      if (!roomCode || !playerId) {
        throw new Error('You are not in a room.');
      }

      if (!body?.playerId) {
        throw new Error('Player ID is required.');
      }

      const { room, playerName } = this.roomsService.kickPlayer(
        roomCode,
        playerId,
        body.playerId,
      );

      this.disconnectPlayerSockets(roomCode, body.playerId, {
        roomCode,
        message: 'The host removed you from the room.',
      });

      if (!room) {
        this.server.to(roomCode).emit('room:closed', {
          roomCode,
          message: 'The room is now closed.',
        });

        return;
      }

      this.server
        .to(roomCode)
        .emit('room:updated', this.roomsService.getPublicState(room));

      this.server.to(roomCode).emit('room:player-removed', {
        playerName,
        reason: 'kicked',
        message: `${playerName} was removed by the host.`,
      });

      console.log(`Player removed from room ${roomCode}: ${playerName}`);
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  @SubscribeMessage('room:leave')
  handleLeaveRoom(@ConnectedSocket() client: Socket): void {
    try {
      const roomCode = client.data.roomCode as string | undefined;
      const playerId = client.data.playerId as string | undefined;

      if (!roomCode || !playerId) {
        throw new Error('You are not in a room.');
      }

      const playerKey = this.getPlayerKey(roomCode, playerId);
      const activeSocketId = this.activeSocketIds.get(playerKey);

      if (activeSocketId !== client.id) {
        throw new Error('This connection is no longer active.');
      }

      // Leave the socket room BEFORE removing the seat: removing the seat
      // notifies the game layer, which broadcasts 'game:aborted' to the room
      // for the players who stay. Leaving first keeps that broadcast — and
      // every other room message — away from this player, who is already
      // back on the main screen and must not see "a player left".
      this.activeSocketIds.delete(playerKey);

      delete client.data.roomCode;
      delete client.data.playerId;

      void client.leave(roomCode);

      const room = this.roomsService.removePlayer(roomCode, playerId);

      if (!room) {
        this.server.to(roomCode).emit('room:closed', {
          roomCode,
          message: 'The room is now closed.',
        });

        return;
      }

      this.server
        .to(roomCode)
        .emit('room:updated', this.roomsService.getPublicState(room));

      client.emit('room:left', { roomCode });
    } catch (error: unknown) {
      this.emitError(client, error);
    }
  }

  private ensureNotInRoom(client: Socket, isReconnecting = false): void {
    if (client.data.roomCode || client.data.playerId) {
      if (isReconnecting) {
        delete client.data.roomCode;
        delete client.data.playerId;
        return;
      }
      throw new Error('You are already in a room.');
    }
  }

  /** A reconnect may repeat on the same socket, but never switch seats. */
  private ensureSameSeat(client: Socket, playerId: string): void {
    if (client.data.playerId && client.data.playerId !== playerId) {
      throw new Error('You are already in a room.');
    }
  }

  private registerPlayerSocket(
    client: Socket,
    roomCode: string,
    playerId: string,
  ): void {
    const playerKey = this.getPlayerKey(roomCode, playerId);

    // Same seat opened from a second tab/device (or a refresh that beat the
    // server's disconnect detection): the newest socket wins and the old one
    // is detached, so game lookups can never land on the stale socket.
    const previousSocketId = this.activeSocketIds.get(playerKey);

    if (previousSocketId && previousSocketId !== client.id) {
      const previous = this.server.sockets.sockets.get(previousSocketId);

      if (previous) {
        delete previous.data.roomCode;
        delete previous.data.playerId;
        void previous.leave(roomCode);
        previous.emit('room:replaced', {
          message: 'This seat was opened in another tab or device.',
        });
      }
    }

    this.activeSocketIds.set(playerKey, client.id);

    client.data.roomCode = roomCode;
    client.data.playerId = playerId;
  }

  private getPlayerKey(roomCode: string, playerId: string): string {
    return `${roomCode}:${playerId}`;
  }

  /** Detach every live socket that belongs to a player being removed. */
  private disconnectPlayerSockets(
    roomCode: string,
    playerId: string,
    kickedPayload: { roomCode: string; message: string },
  ): void {
    const playerKey = this.getPlayerKey(roomCode, playerId);

    this.activeSocketIds.delete(playerKey);

    for (const socket of this.server.sockets.sockets.values()) {
      if (
        socket.data.roomCode !== roomCode ||
        socket.data.playerId !== playerId
      ) {
        continue;
      }

      socket.emit('room:kicked', kickedPayload);

      delete socket.data.roomCode;
      delete socket.data.playerId;

      void socket.leave(roomCode);
    }
  }

  private emitError(client: Socket, error: unknown): void {
    const message =
      error instanceof Error ? error.message : 'An unexpected error occurred.';

    client.emit('room:error', { message });
  }
}
