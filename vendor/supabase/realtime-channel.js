import { CHANNEL_EVENTS, CHANNEL_STATES } from './constants.js';
import Push from './push.js';
import Timer from './timer.js';
import RealtimePresence from './realtime-presence.js';
import * as Transformers from './transformers.js';

export let REALTIME_POSTGRES_CHANGES_LISTEN_EVENT;
(function (REALTIME_POSTGRES_CHANGES_LISTEN_EVENT) {
  REALTIME_POSTGRES_CHANGES_LISTEN_EVENT['ALL'] = '*';
  REALTIME_POSTGRES_CHANGES_LISTEN_EVENT['INSERT'] = 'INSERT';
  REALTIME_POSTGRES_CHANGES_LISTEN_EVENT['UPDATE'] = 'UPDATE';
  REALTIME_POSTGRES_CHANGES_LISTEN_EVENT['DELETE'] = 'DELETE';
})(
  REALTIME_POSTGRES_CHANGES_LISTEN_EVENT ||
    (REALTIME_POSTGRES_CHANGES_LISTEN_EVENT = {})
);
export let REALTIME_LISTEN_TYPES;
(function (REALTIME_LISTEN_TYPES) {
  REALTIME_LISTEN_TYPES['BROADCAST'] = 'broadcast';
  REALTIME_LISTEN_TYPES['PRESENCE'] = 'presence';
  REALTIME_LISTEN_TYPES['POSTGRES_CHANGES'] = 'postgres_changes';
})(REALTIME_LISTEN_TYPES || (REALTIME_LISTEN_TYPES = {}));
export let REALTIME_SUBSCRIBE_STATES;
(function (REALTIME_SUBSCRIBE_STATES) {
  REALTIME_SUBSCRIBE_STATES['SUBSCRIBED'] = 'SUBSCRIBED';
  REALTIME_SUBSCRIBE_STATES['TIMED_OUT'] = 'TIMED_OUT';
  REALTIME_SUBSCRIBE_STATES['CLOSED'] = 'CLOSED';
  REALTIME_SUBSCRIBE_STATES['CHANNEL_ERROR'] = 'CHANNEL_ERROR';
})(REALTIME_SUBSCRIBE_STATES || (REALTIME_SUBSCRIBE_STATES = {}));

/** A channel is the basic building block of Realtime
 * and narrows the scope of data flow to subscribed clients.
 * You can think of a channel as a chatroom where participants are able to see
 * who's online and send and receive messages.
 **/
export default class RealtimeChannel {
  constructor(
    /** Topic name can be any string. */
    topic,
    params = { config: {} },
    socket
  ) {
    this.topic = topic;
    this.params = params;
    this.socket = socket;
    this.bindings = {};
    this.state = CHANNEL_STATES.closed;
    this.joinedOnce = false;
    this.pushBuffer = [];
    this.params.config = {
      ...{
        broadcast: { ack: false, self: false },
        presence: { key: '' }
      },
      ...params.config
    };
    this.timeout = this.socket.timeout;
    this.joinPush = new Push(
      this,
      CHANNEL_EVENTS.join,
      this.params,
      this.timeout
    );
    this.rejoinTimer = new Timer(
      () => this._rejoinUntilConnected(),
      this.socket.reconnectAfterMs
    );
    this.joinPush.receive('ok', () => {
      this.state = CHANNEL_STATES.joined;
      this.rejoinTimer.reset();
      this.pushBuffer.forEach((pushEvent) => pushEvent.send());
      this.pushBuffer = [];
    });
    this._onClose(() => {
      this.rejoinTimer.reset();
      this.socket.log('channel', `close ${this.topic} ${this._joinRef()}`);
      this.state = CHANNEL_STATES.closed;
      this.socket._remove(this);
    });
    this._onError((reason) => {
      if (this._isLeaving() || this._isClosed()) {
        return;
      }

      this.socket.log('channel', `error ${this.topic}`, reason);
      this.state = CHANNEL_STATES.errored;
      this.rejoinTimer.scheduleTimeout();
    });
    this.joinPush.receive('timeout', () => {
      if (!this._isJoining()) {
        return;
      }

      this.socket.log(
        'channel',
        `timeout ${this.topic}`,
        this.joinPush.timeout
      );
      this.state = CHANNEL_STATES.errored;
      this.rejoinTimer.scheduleTimeout();
    });
    this._on(CHANNEL_EVENTS.reply, {}, (payload, ref) => {
      this._trigger(this._replyEventName(ref), payload);
    });
    this.presence = new RealtimePresence(this);
  }

  /** Subscribe registers your client with the server */
  subscribe(callback, timeout = this.timeout) {
    if (this.joinedOnce) {
      throw `tried to subscribe multiple times. 'subscribe' can only be called a single time per channel instance`;
    } else {
      const {
        config: { broadcast, presence }
      } = this.params;

      this._onError((e) => callback && callback('CHANNEL_ERROR', e));
      this._onClose(() => callback && callback('CLOSED'));

      const accessTokenPayload = {};
      const config = {
        broadcast,
        presence,
        postgres_changes:
          this.bindings.postgres_changes?.map((r) => r.filter) ?? []
      };

      if (this.socket.accessToken) {
        accessTokenPayload.access_token = this.socket.accessToken;
      }

      this.updateJoinPayload({ ...{ config }, ...accessTokenPayload });
      this.joinedOnce = true;
      this._rejoin(timeout);
      this.joinPush
        .receive('ok', ({ postgres_changes: serverPostgresFilters }) => {
          this.socket.accessToken &&
            this.socket.setAuth(this.socket.accessToken);

          if (serverPostgresFilters === undefined) {
            callback && callback('SUBSCRIBED');

            return;
          } else {
            const clientPostgresBindings = this.bindings.postgres_changes;
            const bindingsLen = clientPostgresBindings?.length ?? 0;
            const newPostgresBindings = [];

            for (let i = 0; i < bindingsLen; i++) {
              const clientPostgresBinding = clientPostgresBindings[i];
              const {
                filter: { event, schema, table, filter }
              } = clientPostgresBinding;
              const serverPostgresFilter =
                serverPostgresFilters && serverPostgresFilters[i];

              if (
                serverPostgresFilter &&
                serverPostgresFilter.event === event &&
                serverPostgresFilter.schema === schema &&
                serverPostgresFilter.table === table &&
                serverPostgresFilter.filter === filter
              ) {
                newPostgresBindings.push({
                  ...clientPostgresBinding,
                  id: serverPostgresFilter.id
                });
              } else {
                this.unsubscribe();
                callback &&
                  callback(
                    'CHANNEL_ERROR',
                    new Error(
                      'mismatch between server and client bindings for postgres changes'
                    )
                  );

                return;
              }
            }

            this.bindings.postgres_changes = newPostgresBindings;
            callback && callback('SUBSCRIBED');

            return;
          }
        })
        .receive('error', (error) => {
          callback &&
            callback(
              'CHANNEL_ERROR',
              new Error(
                JSON.stringify(Object.values(error).join(', ') || 'error')
              )
            );

          return;
        })
        .receive('timeout', () => {
          callback && callback('TIMED_OUT');

          return;
        });
    }

    return this;
  }

  presenceState() {
    return this.presence.state;
  }

  async track(payload, opts = {}) {
    return await this.send(
      {
        type: 'presence',
        event: 'track',
        payload
      },
      opts.timeout || this.timeout
    );
  }

  async untrack(opts = {}) {
    return await this.send(
      {
        type: 'presence',
        event: 'untrack'
      },
      opts
    );
  }

  on(type, filter, callback) {
    return this._on(type, filter, callback);
  }

  send(payload, opts = {}) {
    return new Promise((resolve) => {
      const push = this._push(
        payload.type,
        payload,
        opts.timeout || this.timeout
      );

      if (push.rateLimited) {
        resolve('rate limited');
      }

      if (
        payload.type === 'broadcast' &&
        !this.params?.config?.broadcast?.ack
      ) {
        resolve('ok');
      }

      push.receive('ok', () => resolve('ok'));
      push.receive('timeout', () => resolve('timed out'));
    });
  }

  updateJoinPayload(payload) {
    this.joinPush.updatePayload(payload);
  }

  /**
   * Leaves the channel.
   *
   * Unsubscribes from server events, and instructs channel to terminate on server.
   * Triggers onClose() hooks.
   *
   * To receive leave acknowledgements, use the a `receive` hook to bind to the server ack, ie:
   * channel.unsubscribe().receive("ok", () => alert("left!") )
   */
  unsubscribe(timeout = this.timeout) {
    this.state = CHANNEL_STATES.leaving;

    const onClose = () => {
      this.socket.log('channel', `leave ${this.topic}`);
      this._trigger(CHANNEL_EVENTS.close, 'leave', this._joinRef());
    };

    this.rejoinTimer.reset();
    // Destroy joinPush to avoid connection timeouts during unscription phase
    this.joinPush.destroy();

    return new Promise((resolve) => {
      const leavePush = new Push(this, CHANNEL_EVENTS.leave, {}, timeout);

      leavePush
        .receive('ok', () => {
          onClose();
          resolve('ok');
        })
        .receive('timeout', () => {
          onClose();
          resolve('timed out');
        })
        .receive('error', () => {
          resolve('error');
        });
      leavePush.send();

      if (!this._canPush()) {
        leavePush.trigger('ok', {});
      }
    });
  }

  /** @internal */
  _push(event, payload, timeout = this.timeout) {
    if (!this.joinedOnce) {
      throw `tried to push '${event}' to '${this.topic}' before joining. Use channel.subscribe() before pushing events`;
    }

    let pushEvent = new Push(this, event, payload, timeout);

    if (this._canPush()) {
      pushEvent.send();
    } else {
      pushEvent.startTimeout();
      this.pushBuffer.push(pushEvent);
    }

    return pushEvent;
  }

  /**
   * Overridable message hook
   *
   * Receives all events for specialized message handling before dispatching to the channel callbacks.
   * Must return the payload, modified or unmodified.
   *
   * @internal
   */
  _onMessage(_event, payload, _ref) {
    return payload;
  }

  /** @internal */
  _isMember(topic) {
    return this.topic === topic;
  }

  /** @internal */
  _joinRef() {
    return this.joinPush.ref;
  }

  /** @internal */
  _trigger(type, payload, ref) {
    const typeLower = type.toLocaleLowerCase();
    const { close, error, leave, join } = CHANNEL_EVENTS;
    const events = [close, error, leave, join];

    if (ref && events.indexOf(typeLower) >= 0 && ref !== this._joinRef()) {
      return;
    }

    let handledPayload = this._onMessage(typeLower, payload, ref);

    if (payload && !handledPayload) {
      throw 'channel onMessage callbacks must return the payload, modified or unmodified';
    }

    if (['insert', 'update', 'delete'].includes(typeLower)) {
      this.bindings.postgres_changes
        ?.filter((bind) => {
          return (
            bind.filter?.event === '*' ||
            bind.filter?.event?.toLocaleLowerCase() === typeLower
          );
        })
        .map((bind) => bind.callback(handledPayload, ref));
    } else {
      this.bindings[typeLower]
        ?.filter((bind) => {
          if (
            ['broadcast', 'presence', 'postgres_changes'].includes(typeLower)
          ) {
            if ('id' in bind) {
              const bindId = bind.id;
              const bindEvent = bind.filter?.event;

              return (
                bindId &&
                payload.ids?.includes(bindId) &&
                (bindEvent === '*' ||
                  bindEvent?.toLocaleLowerCase() ===
                    payload.data?.type.toLocaleLowerCase())
              );
            } else {
              const bindEvent = bind?.filter?.event?.toLocaleLowerCase();

              return (
                bindEvent === '*' ||
                bindEvent === payload?.event?.toLocaleLowerCase()
              );
            }
          } else {
            return bind.type.toLocaleLowerCase() === typeLower;
          }
        })
        .map((bind) => {
          if (typeof handledPayload === 'object' && 'ids' in handledPayload) {
            const postgresChanges = handledPayload.data;
            const { schema, table, commit_timestamp, type, errors } =
              postgresChanges;
            const enrichedPayload = {
              schema: schema,
              table: table,
              commit_timestamp: commit_timestamp,
              eventType: type,
              new: {},
              old: {},
              errors: errors
            };

            handledPayload = {
              ...enrichedPayload,
              ...this._getPayloadRecords(postgresChanges)
            };
          }

          bind.callback(handledPayload, ref);
        });
    }
  }

  /** @internal */
  _isClosed() {
    return this.state === CHANNEL_STATES.closed;
  }

  /** @internal */
  _isJoined() {
    return this.state === CHANNEL_STATES.joined;
  }

  /** @internal */
  _isJoining() {
    return this.state === CHANNEL_STATES.joining;
  }

  /** @internal */
  _isLeaving() {
    return this.state === CHANNEL_STATES.leaving;
  }

  /** @internal */
  _replyEventName(ref) {
    return `chan_reply_${ref}`;
  }

  /** @internal */
  _on(type, filter, callback) {
    const typeLower = type.toLocaleLowerCase();
    const binding = {
      type: typeLower,
      filter: filter,
      callback: callback
    };

    if (this.bindings[typeLower]) {
      this.bindings[typeLower].push(binding);
    } else {
      this.bindings[typeLower] = [binding];
    }

    return this;
  }

  /** @internal */
  _off(type, filter) {
    const typeLower = type.toLocaleLowerCase();

    this.bindings[typeLower] = this.bindings[typeLower].filter((bind) => {
      return !(
        bind.type?.toLocaleLowerCase() === typeLower &&
        RealtimeChannel.isEqual(bind.filter, filter)
      );
    });

    return this;
  }

  /** @internal */
  static isEqual(obj1, obj2) {
    if (Object.keys(obj1).length !== Object.keys(obj2).length) {
      return false;
    }

    for (const k in obj1) {
      if (obj1[k] !== obj2[k]) {
        return false;
      }
    }

    return true;
  }

  /** @internal */
  _rejoinUntilConnected() {
    this.rejoinTimer.scheduleTimeout();

    if (this.socket.isConnected()) {
      this._rejoin();
    }
  }

  /**
   * Registers a callback that will be executed when the channel closes.
   *
   * @internal
   */
  _onClose(callback) {
    this._on(CHANNEL_EVENTS.close, {}, callback);
  }

  /**
   * Registers a callback that will be executed when the channel encounteres an error.
   *
   * @internal
   */
  _onError(callback) {
    this._on(CHANNEL_EVENTS.error, {}, (reason) => callback(reason));
  }

  /**
   * Returns `true` if the socket is connected and the channel has been joined.
   *
   * @internal
   */
  _canPush() {
    return this.socket.isConnected() && this._isJoined();
  }

  /** @internal */
  _rejoin(timeout = this.timeout) {
    if (this._isLeaving()) {
      return;
    }

    this.socket._leaveOpenTopic(this.topic);
    this.state = CHANNEL_STATES.joining;
    this.joinPush.resend(timeout);
  }

  /** @internal */
  _getPayloadRecords(payload) {
    const records = {
      new: {},
      old: {}
    };

    if (payload.type === 'INSERT' || payload.type === 'UPDATE') {
      records.new = Transformers.convertChangeData(
        payload.columns,
        payload.record
      );
    }

    if (payload.type === 'UPDATE' || payload.type === 'DELETE') {
      records.old = Transformers.convertChangeData(
        payload.columns,
        payload.old_record
      );
    }

    return records;
  }
}
