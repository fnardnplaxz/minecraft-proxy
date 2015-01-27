/**
 * Created by bangbang on 15/01/10.
 */
var net = require('net');
var protocol = require('./protocol');
var fun = require('./function');
require('./command');

var fs = require('fs');

global.Config = JSON.parse(fs.readFileSync('config.json', 'utf8'));

var connections = {};
var ips = {};

var servers = [];

if (!Array.isArray(Config.port)){
    Config.port = [Config.port];
}


Config.port.forEach(function (e){
    var server = net.createServer();
    server.on('connection', onConnection);
    server.listen(e, Config.host);
    server.on('listening', function (){
        console.log('proxy is ready on ' + Config.host + ':' + e);
    });
    server.on('error', function (err){
        onError(e, err);
    });
    servers.push(server);
});

function makePipe(client, server, handshake, login, serverInfo){
    client.pipe(server).pipe(client);
    console.log('add connection');
    if (handshake){
        connections['uuid'] = {
            socket: client
        };
        for(var i in handshake){
            connections['uuid'][i] = handshake[i];
        }
        client.on('end', (function(uuid){
            return function(){
                removeConnection(uuid)
            };
        })(handshake['uuid']));
        console.log('piping ' + login['username'] + '(' + handshake['uuid'] + ')' +
        '[' + client.remoteAddress + ':' + client.remotePort + '] to '
        + handshake['originHost'] + '[' + serverInfo['host'] + ':' + serverInfo['port'] + ']');
    } else {
        console.log(client.remoteAddress + 'for pinging');
    }
}

function removeConnection(uuid){
    delete connections[uuid];
}

function onConnection(client) {
    if (checkBanIp(client.remoteAddress)){
        fun.close(client, 'ip被封禁');
        return;
    }
    ips[client.remoteAddress] = ips[client.remoteAddress] ++ ||1;
    if (!checkGlobalIp(client.remoteAddress)){
        fun.close(client, '超过单IP并发限制');
        return;
    }
    var buffer = new Buffer(0);
    var state = 'handshaking';
    var handshake;
    var uuid;
    client.on('data', function (data){
        buffer = Buffer.concat([buffer, data]);
        while (true){
            var result = protocol.parsePacket(buffer, state, true, {
                set_protocol: 1,
                ping_start: 1,
                login_start: 1
            });
            if (!result){
                break;
            }
            if (result.error){
                break;
            }
            console.log(state);
            if (state == 'handshaking'){
                if (result.results['nextState'] == 1){
                    var server = getServer(result.results['serverHost'], result.results['serverPort']);
                    if (!server){
                        client.end();
                    } else {
                        var mc = net.connect(server);
                        (function (mc, buffer){
                            mc.on('error', function (err){
                                mcError(mc, err);
                            });
                            mc.on('connect', function (){
                                mc.write(buffer);
                                client.removeAllListeners('data');
                                makePipe(client, mc);
                            })
                        })(mc, buffer);
                    }
                } else {
                    handshake = result.results;
                    state = 'login';
                }
            } else if (state = 'login'){
                server = getServer(handshake['serverHost'], handshake['serverPort']);
                if (!server){
                    fun.close(client, '服务器不存在');
                } else {
                    mc = net.connect(server);
                    (function (mc, result, server){
                        mc.on('error', function (err){
                            mcError(server, err);
                        });
                        mc.on('connect', function (){
                            var packet = result.results;
                            var usernameMD5 = fun.md5(packet['username']);
                            uuid = usernameMD5.substr(0,8) + '-' + usernameMD5.substr(8,4) + '-' + usernameMD5.substr(12,4) + '-' + usernameMD5.substr(16,4) + '-' + usernameMD5.substr(20,12);
                            handshake['uuid'] = uuid;
                            handshake['originHost'] = handshake['serverHost'];
                            handshake['serverHost'] += '\0' + client.remoteAddress + '\0' + uuid;
                            var handshakePacket = protocol.createPacketBuffer(0x00, 'handshaking', handshake, false);
                            var loginPacket = protocol.createPacketBuffer(0x00, 'login', packet, false);
                            var newBuffer = Buffer.concat([handshakePacket, loginPacket]);
                            mc.write(newBuffer);
                            client.removeAllListeners('data');
                            makePipe(client, mc, handshake, packet, server);
                        })
                    })(mc, result, server);
                }

            }
            buffer = buffer.slice(result.size);
        }
    });
    client.on('close', function (){
        onClose(client);
    })
}

function onError(port, err){
    console.error("Server on port " + port + " couldn't work property" );
    console.trace(err);
}

function onClose(client){
    ips[client.remoteAddress] --;
}

function mcError(server, err){
    console.error("Couldn't connect to " + server.host + ':' + server.port);
    console.trace(err);
}

function getServer(serverName, serverPort){
    return Config['servers'][serverName + ':' + serverPort] ||
        Config['servers'][serverName] ||
        Config['servers'][serverPort] ||
        Config['servers'][Config['default']];
}

function checkGlobalIp(ip){
    var ipLimit = Config['ipLimit'][ip]||Config['ipLimit']['default'] || -1;
    if (ipLimit == -1){
        return true;
    }
    var nowIp = ips[ip] || 0;
    return nowIp < ipLimit;
}

function checkBanIp(ip){
    return global.Config['ban']['ip'].indexOf(ip) !== -1;

}


//process.on('uncaughtException', function (err){
//    console.trace(err);
//});