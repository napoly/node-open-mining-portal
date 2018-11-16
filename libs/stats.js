var zlib = require('zlib');

var redis = require('redis');
var async = require('async');


var os = require('os');

var algos = require('stratum-pool/lib/algoProperties.js');


module.exports = function(logger, portalConfig, poolConfigs){

    var _this = this;

    var logSystem = 'Stats';

    var redisClients = [];
    var redisStats;

    this.statHistory = [];
    this.statPoolHistory = [];

    this.stats = {};
    this.statsString = '';

    setupStatsRedis();
    gatherStatHistory();

    var canDoStats = true;

    Object.keys(poolConfigs).forEach(function(coin){

        if (!canDoStats) return;

        var poolConfig = poolConfigs[coin];

        var redisConfig = poolConfig.redis;

        for (var i = 0; i < redisClients.length; i++){
            var client = redisClients[i];
            if (client.client.port === redisConfig.port && client.client.host === redisConfig.host){
                client.coins.push(coin);
                return;
            }
        }
        redisClients.push({
            coins: [coin],
            client: redis.createClient(redisConfig.port, redisConfig.host)
        });
    });


    function setupStatsRedis(){
        redisStats = redis.createClient(portalConfig.redis.port, portalConfig.redis.host);
        redisStats.on('error', function(err){
            logger.error(logSystem, 'Historics', 'Redis for stats had an error ' + JSON.stringify(err));
        });
    }

    this.getBlocks = function (cback) {
        var allBlocks = {};
        async.each(_this.stats.pools, function(pool, pcb) {
            if (_this.stats.pools[pool.name].pending && _this.stats.pools[pool.name].pending.blocks)
                for (var i=0; i<_this.stats.pools[pool.name].pending.blocks.length; i++)
                    allBlocks[pool.name+"-"+_this.stats.pools[pool.name].pending.blocks[i].split(':')[2]] = _this.stats.pools[pool.name].pending.blocks[i];
            if (_this.stats.pools[pool.name].confirmed && _this.stats.pools[pool.name].confirmed.blocks)
                for (var i=0; i<_this.stats.pools[pool.name].confirmed.blocks.length; i++)
                    allBlocks[pool.name+"-"+_this.stats.pools[pool.name].confirmed.blocks[i].split(':')[2]] = _this.stats.pools[pool.name].confirmed.blocks[i];
            pcb();
        }, function(err) {
            cback(allBlocks);
        });
    };

    function gatherStatHistory(){

        var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0).toString();

        redisStats.zrangebyscore(['statHistory', retentionTime, '+inf'], function(err, replies){
            if (err) {
                logger.error(logSystem, 'Historics', 'Error when trying to grab historical stats ' + JSON.stringify(err));
                return;
            }
            for (var i = 0; i < replies.length; i++){
                _this.statHistory.push(JSON.parse(replies[i]));
            }
            _this.statHistory = _this.statHistory.sort(function(a, b){
                return a.time - b.time;
            });
            _this.statHistory.forEach(function(stats){
                addStatPoolHistory(stats);
            });
        });
    }

    var magnitude = 100000000;
    var coinPrecision = magnitude.toString().length - 1;

    function roundTo(n, digits) {
        if (digits === undefined) {
            digits = 0;
        }
        var multiplicator = Math.pow(10, digits);
        n = parseFloat((n * multiplicator).toFixed(11));
        var test =(Math.round(n) / multiplicator);
        return +(test.toFixed(digits));
    }

    var satoshisToCoins = function(satoshis){
        return roundTo((satoshis / magnitude), coinPrecision);
    };

    function coinsRound(number) {
        return roundTo(number, coinPrecision);
    }

    function addStatPoolHistory(stats){
        var data = {
            time: stats.time,
            pools: {}
        };
        for (var pool in stats.pools){
            data.pools[pool] = {
                hashrate: stats.pools[pool].hashrate,
                workerCount: stats.pools[pool].workerCount,
                blocks: stats.pools[pool].blocks
            }
        }
        _this.statPoolHistory.push(data);
    }

    this.getGlobalStats = function(callback){

        var statGatherTime = Date.now() / 1000 | 0;

        var allCoinStats = {};

        async.each(redisClients, function(client, callback){
            var windowTime = (((Date.now() / 1000) - portalConfig.website.stats.hashrateWindow) | 0).toString();
            var redisCommands = [];


            var redisCommandTemplates = [
                ['zremrangebyscore', ':hashrate', '-inf', '(' + windowTime],
                ['zrangebyscore', ':hashrate', windowTime, '+inf'],
                ['hgetall', ':stats'],
                ['scard', ':blocksPending'],
                ['scard', ':blocksConfirmed'],
                ['scard', ':blocksKicked'],
                ['smembers', ':blocksPending'],
                ['smembers', ':blocksConfirmed'],
                ['hgetall', ':shares:roundCurrent'],
                ['hgetall', ':blocksPendingConfirms'],
                ['zrange', ':payments', -100, -1],
                ['hgetall', ':shares:timesCurrent']
            ];

            var commandsPerCoin = redisCommandTemplates.length;

            client.coins.map(function(coin){
                redisCommandTemplates.map(function(t){
                    var clonedTemplates = t.slice(0);
                    clonedTemplates[1] = coin + clonedTemplates[1];
                    redisCommands.push(clonedTemplates);
                });
            });


            client.client.multi(redisCommands).exec(function(err, replies){
                if (err){
                    logger.error(logSystem, 'Global', 'error with getting global stats ' + JSON.stringify(err));
                    callback(err);
                }
                else{
                    for(var i = 0; i < replies.length; i += commandsPerCoin){
                        var coinName = client.coins[i / commandsPerCoin | 0];
                        var coinStats = {
                            name: coinName,
                            symbol: poolConfigs[coinName].coin.symbol.toUpperCase(),
                            algorithm: poolConfigs[coinName].coin.algorithm,
                            hashrates: replies[i + 1],
                            poolStats: {
                                validShares: replies[i + 2] ? (replies[i + 2].validShares || 0) : 0,
                                validBlocks: replies[i + 2] ? (replies[i + 2].validBlocks || 0) : 0,
                                invalidShares: replies[i + 2] ? (replies[i + 2].invalidShares || 0) : 0,
                                totalPaid: replies[i + 2] ? (replies[i + 2].totalPaid || 0) : 0
                            },
                            /* block stat counts */
                            blocks: {
                                pending: replies[i + 3],
                                confirmed: replies[i + 4],
                                orphaned: replies[i + 5]
                            },
                            /* show all pending blocks */
                            pending: {
                                blocks: replies[i + 6].sort(sortBlocks),
                                confirms: (replies[i + 9] || {})
                            },
                            /* show last 50 found blocks */
                            confirmed: {
                                blocks: replies[i + 7].sort(sortBlocks).slice(0,50)
                            },
                            payments: [],
                            currentRoundShares: (replies[i + 8] || {}),
                            currentRoundTimes: (replies[i + 11] || {}),
                            maxRoundTime: 0,
                            shareCount: 0
                        };
                        for(var j = replies[i + 10].length; j > 0; j--){
                            var jsonObj;
                            try {
                                jsonObj = JSON.parse(replies[i + 10][j-1]);
                            } catch(e) {
                                jsonObj = null;
                            }
                            if (jsonObj !== null) {
                                coinStats.payments.push(jsonObj);
                            }
                        }
                        allCoinStats[coinStats.name] = (coinStats);
                    }
                    callback();
                }
            });
        }, function(err){
            if (err){
                logger.error(logSystem, 'Global', 'error getting all stats' + JSON.stringify(err));
                callback();
                return;
            }

            var portalStats = {
                time: statGatherTime,
                global:{
                    workers: 0,
                    hashrate: 0
                },
                algos: {},
                pools: allCoinStats
            };

            Object.keys(allCoinStats).forEach(function(coin){
                var coinStats = allCoinStats[coin];
                coinStats.workers = {};
                coinStats.shares = 0;
                coinStats.hashrates.forEach(function(ins){
                    var parts = ins.split(':');
                    var workerShares = parseFloat(parts[0]);
                    var worker = parts[1];
                    if (workerShares > 0) {
                        coinStats.shares += workerShares;
                        if (worker in coinStats.workers)
                            coinStats.workers[worker].shares += workerShares;
                        else
                            coinStats.workers[worker] = {
                                shares: workerShares,
                                invalidshares: 0,
                                hashrateString: null
                            };
                    }
                    else {
                        if (worker in coinStats.workers)
                            coinStats.workers[worker].invalidshares -= workerShares; // workerShares is negative number!
                        else
                            coinStats.workers[worker] = {
                                shares: 0,
                                invalidshares: -workerShares,
                                hashrateString: null
                            };
                    }
                });

                var shareMultiplier = Math.pow(2, 32) / algos[coinStats.algorithm].multiplier;
                coinStats.hashrate = shareMultiplier * coinStats.shares / portalConfig.website.stats.hashrateWindow;

                coinStats.workerCount = Object.keys(coinStats.workers).length;
                portalStats.global.workers += coinStats.workerCount;

                /* algorithm specific global stats */
                var algo = coinStats.algorithm;
                if (!portalStats.algos.hasOwnProperty(algo)){
                    portalStats.algos[algo] = {
                        workers: 0,
                        hashrate: 0,
                        hashrateString: null
                    };
                }
                portalStats.algos[algo].hashrate += coinStats.hashrate;
                portalStats.algos[algo].workers += Object.keys(coinStats.workers).length;

                for (var worker in coinStats.workers) {
                    coinStats.workers[worker].hashrateString = _this.getReadableHashRateString(shareMultiplier * coinStats.workers[worker].shares / portalConfig.website.stats.hashrateWindow);
                }

                delete coinStats.hashrates;
                delete coinStats.shares;
                coinStats.hashrateString = _this.getReadableHashRateString(coinStats.hashrate);
            });

            Object.keys(portalStats.algos).forEach(function(algo){
                var algoStats = portalStats.algos[algo];
                algoStats.hashrateString = _this.getReadableHashRateString(algoStats.hashrate);
            });

            _this.stats = portalStats;
            _this.statsString = JSON.stringify(portalStats);



            _this.statHistory.push(portalStats);
            addStatPoolHistory(portalStats);

            var retentionTime = (((Date.now() / 1000) - portalConfig.website.stats.historicalRetention) | 0);

            for (var i = 0; i < _this.statHistory.length; i++){
                if (retentionTime < _this.statHistory[i].time){
                    if (i > 0) {
                        _this.statHistory = _this.statHistory.slice(i);
                        _this.statPoolHistory = _this.statPoolHistory.slice(i);
                    }
                    break;
                }
            }

            redisStats.multi([
                ['zadd', 'statHistory', statGatherTime, _this.statsString],
                ['zremrangebyscore', 'statHistory', '-inf', '(' + retentionTime]
            ]).exec(function(err, replies){
                if (err)
                    logger.error(logSystem, 'Historics', 'Error adding stats to historics ' + JSON.stringify(err));
            });
            callback();
        });

    };

    this.getTotalSharesByAddress = function(address, cback) {
        var a = address.split(".")[0];
        var client = redisClients[0].client,
            coins = redisClients[0].coins,
            shares = [];

        var pindex = parseInt(0);
        var totalShares = parseFloat(0);
        async.each(_this.stats.pools, function(pool, pcb) {
            pindex++;
            var coin = String(_this.stats.pools[pool.name].name);
            client.hscan(coin + ':shares:roundCurrent', 0, "match", a+"*", "count", 1000, function(error, result) {
                if (error) {
                    pcb(error);
                    return;
                }
                var workerName="";
                var shares = 0;
                for (var i in result[1]) {
                    if (Math.abs(i % 2) != 1) {
                        workerName = String(result[1][i]);
                    } else {
                        shares += parseFloat(result[1][i]);
                    }
                }
                if (shares>0) {
                    totalShares = shares;
                }
                pcb();
            });
        }, function(err) {
            if (err) {
                cback(0);
                return;
            }
            if (totalShares > 0 || (pindex >= Object.keys(_this.stats.pools).length)) {
                cback(totalShares);
                return;
            }
        });
    };

    this.getBalanceByAddress = function(address, cback){

        var a = address.split(".")[0];

        var client = redisClients[0].client,
            coins = redisClients[0].coins,
            balances = [];

        var totalHeld = parseFloat(0);
        var totalPaid = parseFloat(0);
        var totalImmature = parseFloat(0);

        async.each(_this.stats.pools, function(pool, pcb) {
            var coin = String(_this.stats.pools[pool.name].name);
            // get all immature balances from address
            client.hscan(coin + ':immature', 0, "match", a+"*", "count", 10000, function(error, pends) {
                // get all balances from address
                client.hscan(coin + ':balances', 0, "match", a+"*", "count", 10000, function(error, bals) {
                    // get all payouts from address
                    client.hscan(coin + ':payouts', 0, "match", a+"*", "count", 10000, function(error, pays) {

                        var workerName = "";
                        var balAmount = 0;
                        var paidAmount = 0;
                        var pendingAmount = 0;

                        var workers = {};

                        for (var i in pays[1]) {
                            if (Math.abs(i % 2) != 1) {
                                workerName = String(pays[1][i]);
                                workers[workerName] = (workers[workerName] || {});
                            } else {
                                paidAmount = parseFloat(pays[1][i]);
                                workers[workerName].paid = coinsRound(paidAmount);
                                totalPaid += paidAmount;
                            }
                        }
                        for (var b in bals[1]) {
                            if (Math.abs(b % 2) != 1) {
                                workerName = String(bals[1][b]);
                                workers[workerName] = (workers[workerName] || {});
                            } else {
                                balAmount = parseFloat(bals[1][b]);
                                workers[workerName].balance = coinsRound(balAmount);
                                totalHeld += balAmount;
                            }
                        }
                        for (var b in pends[1]) {
                            if (Math.abs(b % 2) != 1) {
                                workerName = String(pends[1][b]);
                                workers[workerName] = (workers[workerName] || {});
                            } else {
                                pendingAmount = parseFloat(pends[1][b]);
                                workers[workerName].immature = coinsRound(pendingAmount);
                                totalImmature += pendingAmount;
                            }
                        }

                        for (var w in workers) {
                            balances.push({
                                worker:String(w),
                                balance:workers[w].balance,
                                paid:workers[w].paid,
                                immature:workers[w].immature
                            });
                        }

                        pcb();
                    });
                });
            });
        }, function(err) {
            if (err) {
                callback("There was an error getting balances");
                return;
            }

            _this.stats.balances = balances;
            _this.stats.address = address;

            cback({totalHeld:coinsRound(totalHeld), totalPaid:coinsRound(totalPaid), totalImmature:satoshisToCoins(totalImmature), balances});
        });
    };

    function sortBlocks(a, b) {
        var as = parseInt(a.split(":")[2]);
        var bs = parseInt(b.split(":")[2]);
        if (as > bs) return -1;
        if (as < bs) return 1;
        return 0;
    }

    this.getReadableHashRateString = function(hashrate){
        hashrate = (hashrate * 1000000);
        if (hashrate < 1000000) {
            return '0 H/s';
        }
        var byteUnits = [ ' H/s', ' KH/s', ' MH/s', ' GH/s', ' TH/s', ' PH/s' ];
        var i = Math.floor((Math.log(hashrate/1000) / Math.log(1000)) - 1);
        hashrate = (hashrate/1000) / Math.pow(1000, i + 1);
        return hashrate.toFixed(2) + byteUnits[i];
    };

};
