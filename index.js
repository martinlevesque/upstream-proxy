
'use strict';

/**
 * Imports
 * ...wait for v8 to implement es6 style
 * import net from 'net';
 * import sni from 'sni';
*/
const net = require('net');
const xpipe = require('xpipe');
const sni = require('sni');

/**
 * Creates a new upstream proxy instance.
 * @class
 */
class UpstreamProxy {

  /**
    * @constructs UpstreamProxy server
    * @param {Object} config - Sets data for calculating the routes.
    * @param {Object} callbacks - Sets callbacks for external error handling.
    * @return {Object}
    */
  constructor(config = {}, callbacks = {}, statsHandler = null) {

    this.active = false;
    this.id = 0;
    this.symId = Symbol('id');
    this.symHostHeader = Symbol('host_header');
    this.host_headers = {};
    this.sockets = new Map();
    this.wildcardLookup = new Map();

    this.status_codes = new Map([
      [400, 'Bad Request'],
      [404, 'Not Found'],
      [500, 'Internal Server Error'],
      [502, 'Bad Gateway'],
      [503, 'Service Unavailable']
    ]);

    try {
      this.config = config;
      [this.routes, this.handlers] = this._generateRoutesMap(this.config);
    }
    catch(e) {
      console.error(e);
    };

    try {
      this.callbacks = callbacks;
    }
    catch(e) {};

    try {
      this.statsHandler = statsHandler;
    } catch(err) {
      console.error(err);
    }

    let server = net.createServer((socket) => this._handleConnection(socket));
    server.start = () => this.start();
    server.stop = () => this.stop();
    server.getStatus = () => this.getStatus();
    server.getConfig = () => this.getConfig();
    server.setConfig = (config) => this.setConfig(config);
    server.getRoutes = () => this.getRoutes();
    server.getCallbacks = () => this.getCallbacks();
    server.setCallbacks = (callbacks) => this.setCallbacks(callbacks);
    server.disconnectClients = (host) => this.disconnectClients(host);
    server.disconnectAllClients = () => this.disconnectAllClients();

    return server;
  }

  /**
   * Handles connections from frontend
   * @param {Object} socket
   */
  _handleConnection(socket) {
    if (!this.active) {
      return socket.end(this._httpResponse(503));
    }

    socket.once('error', (err) => {
      //console.log(err);
      socket.end();
    });

    socket.once('data', (data) => this._handleData(socket, data));
  }

  _findHostHeader(data, socket) {

    let host_header = null;
    let route = null;

    try {
      host_header = this._getHostHeader(data);

      if ( ! host_header) {
        return [null, null];
      }

      route = this.routes.get(host_header);

      if ( ! route) {
        let wildcardFound = false;

        // check if we have it in the fast lookup
        if (this.wildcardLookup.get(host_header)) {
          host_header = this.wildcardLookup.get(host_header);
          wildcardFound = true;
        } else {
          for (let r of this.routes) {
            let routeHost = r[0];

            if (routeHost && routeHost.indexOf("*") === -1) {
              continue;
            }

            let pattern = routeHost.replace("*", "[^.\\s]+");

            let res = host_header.match(new RegExp(pattern))

            if (res && res.length) {
              this.wildcardLookup.set(host_header, r[0]);

              host_header = r[0];
              wildcardFound = true;
              break;
            }
          }
        }

        if ( ! wildcardFound) {
          return [null, null];
        }

        route = this.routes.get(host_header);
      }
    } catch(err) {
      console.log(err);
      host_header = null;
      route = null;
    }

    return [host_header, route];
  }

  /**
   * Handles data from connection handler
   * @param {Object} socket
   * @param {Buffer} data
   */
  _handleData(socket, data) {
    if (data instanceof Buffer === false || data.length < 1) {
      return socket.end(this._httpResponse(400));
    }

    let [host_header, route] = this._findHostHeader(data);

    if ( ! host_header) {
      return socket.end(this._httpResponse(500));
    }

    let handlerPromise = this.handlers.get(host_header);

    if ( ! handlerPromise) {
      handlerPromise = function() {
        return new Promise((resolve) => resolve());
      };
    }

    handlerPromise().then(() => {
      let backend = new net.Socket();

      backend.once('error', (err) => {
        backend.destroy();
        const status = 503;
        if (this.callbacks[status]) {
          this.callbacks[status](socket, host_header);
        } else {
          //throw new Error("There was an error and without err callback: " + err);
          try {
            socket.end(this._httpResponse(500));
          } catch(err) {
            console.log(err);
          }
        }
      });

      backend.on('connect', () => {
        this._addConnection(socket, host_header);
        socket.on('error', () => { this._removeConnection(host_header, socket, backend); });
        backend.on('close', () => { this._removeConnection(host_header, socket, backend); });
        backend.write(data);
        socket.pipe(backend).pipe(socket);
      });

      backend.connect(route);
    }).catch((err) => {
      console.log(err);
      try {
        socket.end(this._httpResponse(500));
      } catch(err2) {
        console.log(err2);
      }
    })
  }

  /**
   * Extracts hostname from buffer
   * @param {Buffer} data
   * @return {string}
   */
  _getHostHeader(data) {
    if (data[0] === 22) { //secure
      return sni(data);
      //return this.routes.get(sni(data));
    } else {
      let result = data.toString('utf8').match(/^(H|h)ost: (\[[^\]]*\]|[^ \:\r\n]+)/im);
      if (result) {
        return result[2];
      }
    }
  }

  /**
   * Adds socket to internal frontend connection tracking
   * @param {Object} socket
   * @param {string} host_header
   */
  _addConnection(socket, host_header) {
    this.id++;
    socket[this.symId] = this.id;
    socket[this.symHostHeader] = host_header;
    this.host_headers[host_header].set(this.id, true);
    this.sockets.set(this.id, socket);
  }

  /**
   * Removes socket from internal frontend connection tracking
   * @param {Object} socket
   * @param {Object} backend
   */
  _removeConnection(hostHeader, socket, backend) {
    this.host_headers[socket[this.symHostHeader]].delete(socket[this.symId]);
    this.sockets.delete(socket[this.symId]);

    if (this.statsHandler) {
      this.statsHandler({
        "host": hostHeader,
        "bytesRead": backend.bytesRead,
        "bytesWritten": backend.bytesWritten
      });
    }

    socket.end();
    socket.unref();
    backend.end();
  }

  /**
   * Generates routes map
   * @param {Object} config
   * @return {Map}
   */
  _generateRoutesMap(config) {
    let routes = new Map();
    let handlers = new Map();
    if (config instanceof Array) {
      for (let obj of config) {
        if (obj.endpoint && obj.endpoint.path) {
          obj.endpoint.path = xpipe.eq(obj.endpoint.path);
        }
        let hosts = obj.hostnames || [];
        for (let host of hosts) {
          if (obj.endpoint) {
            routes.set(host, obj.endpoint);
            handlers.set(host, obj.handler);
            this.host_headers[host] = new Map();
          }
        }
      }
    }
    return [routes, handlers];
  }

  /**
   * Closes frontend connections
   * @param {Array} list_of_ids
   * @return {number}
   */
  _closeFrontendConnections(list_of_ids) {
    let i = 0;
    for (let id of list_of_ids) {
      try {
        this.sockets.get(id).end();
        this.sockets.delete(id);
        i++;
      } catch (e) {
        //console.log(e);
      }
    }
    return i;
  }

  /**
   * Generates client response
   * @param {number} nr
   * @return {string}
   */
  _httpResponse(nr) {
    let reason_phrase = this.status_codes.get(nr);
    if (!reason_phrase) {
      return 'HTTP/1.1 500 Internal Server Error\r\n\r\n';
    }
    return 'HTTP/1.1 ' + nr + ' ' + reason_phrase + '\r\n\r\n';
  }

  /**
   * Returns current configuration
   * @return {Object}
   */
  getConfig() {
    return this.config;
  }

  /**
   * Overwrites current configuration
   * @param {Object} config - Sets data for calculating the routes.
   * @param {Array} config.frontend_connectors - Describes frontend connectors.
   * @param {Array} config.backend_connectors - Describes backend connectors.
   */
  setConfig(config = {}) {
    try {
      this.config = config;
      [this.routes, this.handlers] = this._generateRoutesMap(this.config);
      this.wildcardLookup = new Map();
      return 'OK';
    } catch (e) {
      return 'ERROR: ' + e.message;
    }
  }

  /**
   * Returns current routes
   * @return {Map}
   */
  getRoutes() {
    return this.routes;
  }

  /**
   * Returns current callbacks
   * @return {Object}
   */
  getCallbacks() {
    return this.callbacks;
  }

  /**
   * Overwrites current callbacks
   * @param {Object} callbacks - Sets callbacks for external error handling.
   */
  setCallbacks(callbacks = {}) {
    try {
      this.callbacks = callbacks;
      return 'OK';
    } catch (e) {
      return 'ERROR: ' + e.message;
    }
  }

  /**
   * Starts routing
   * @return {string}
   */
  start() {
    this.active = true;
    return 'OK';
  }

  /**
   * Stops routing
   * @return {string}
   */
  stop() {
    this.active = false;
    return 'OK';
  }

  /**
   * Get status
   * @return {string}
   */
  getStatus() {
    if (this.active === true) {
      return 'active';
    }
    return 'passive';
  }

  /**
   * Disconnect all clients for a host(name)
   * @param {string} host
   * @return {number}
   */
  disconnectClients(host = '') {
    try {
      return this._closeFrontendConnections( Array.from( this.host_headers[host].keys() ) );
    } catch (e) {
      return 0;
    }
  }

  /**
   * Disconnect all clients
   * @return {number}
   */
  disconnectAllClients() {
    try {
      return this._closeFrontendConnections( Array.from( this.sockets.keys() ) );
    } catch (e) {
      return 0;
    }
  }

}

/**
 * Export
 * ...wait for v8 to implement es6 style:
 * export default UpstreamProxy;
*/
module.exports = UpstreamProxy;
