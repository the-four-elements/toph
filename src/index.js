'use strict';

const express = require('express');
const bodyParser = require('body-parser');
const winston = require('winston');
const cors = require('cors');
const mongoose = require('mongoose');
mongoose.Promise = Promise;

const GenericRouter = require('wapi-core').GenericRouter;
const WildcardRouter = require('wapi-core').WildcardRouter;
const ImageRouter = require('./routers/image.router');

const PermMiddleware = require('wapi-core').PermMiddleware;
const AuthMiddleware = require('wapi-core').AccountAPIMiddleware;

const {promisifyAll} = require('tsubaki');
const fs = promisifyAll(require('fs'));
const path = require('path');
winston.remove(winston.transports.Console);
winston.add(winston.transports.Console, {
    timestamp: true,
    colorize: true,
});

let init = async() => {
    let config, pkg;
    try {
        config = require('../config/main.json');
        pkg = require('../package.json');
    } catch (e) {
        winston.error(e);
        winston.error('Failed to require config.');
        return process.exit(1);
    }
    winston.info('Config loaded.');

    if (!config.provider.storage) {
        winston.error('No Storage Provider configured');
        process.exit(1);
    }

    try {
        await mongoose.connect(config.dburl, {useMongoClient: true});
    } catch (e) {
        winston.error('Unable to connect to Mongo Server.');
        return process.exit(1);
    }
    winston.info('MongoDB connected.');

    // Initialize express
    let app = express();

    // Middleware for config
    app.use((req, res, next) => {
        req.config = config;
        next();
    });

    // Some other middleware
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({extended: true}));
    app.use(cors());

    // load fitting authentication middleware
    let authProvider;
    if (config.provider.auth && config.provider.auth.use) {
        if (config.provider.auth.id !== 'account_api') {
            try {
                authProvider = await loadAuthProvider(config);
            } catch (e) {
                winston.error(e);
                winston.error('Unable to load a suitable auth provider');
                return process.exit(1);
            }
        } else {
            // Account API Auth middleware
            authProvider = new AuthMiddleware(config.provider.auth.urlBase, config.provider.auth.uagent, config.provider.auth.whitelist);
        }
        winston.info(`Loaded class ${authProvider.constructor.name} as auth provider`);
        app.use(authProvider.middleware());
    }
    // if there is no auth provider attach a pseudo middleware
    if (!authProvider) {
        winston.warn('No auth provider was set, all routes are unlocked!');
        app.use((req, res, next) => {
            req.account = {name: 'admin', id: 'admin', scopes: ['admin']};
            return next();
        });
    }
    // load a storage provider, used for storing and loading dev-images
    let storageProvider;
    try {
        storageProvider = await loadStorageProvider(config);
    } catch (e) {
        winston.error(e);
        winston.error('Unable to load a suitable storage provider');
        return process.exit(1);
    }
    if (!storageProvider) {
        winston.error('No storage provider was loaded');
        return process.exit(1);
    }

    // serve local files if set in config
    if (config.provider.storage.local && config.provider.storage.local.serveFiles) {
        app.use(config.provider.storage.local.servePath, express.static(config.provider.storage.storagepath));
    }

    winston.info(`Loaded class ${storageProvider.constructor.name} as storage provider`);
    app.use((req, res, next) => {
        req.storageProvider = storageProvider;
        return next();
    });

    app.use(new PermMiddleware(pkg.name, config.env).middleware());

    // Routers
    app.use(new GenericRouter(pkg.version, `Welcome to ${pkg.name}, the weeb image api`).router());
    app.use(new ImageRouter().router());
    // Always use this last
    app.use(new WildcardRouter().router());

    app.listen(config.port, config.host);
    winston.info(`Server started on ${config.host}:${config.port}`);
};
init()
    .catch(e => {
        winston.error(e);
        winston.error('Failed to initialize.');
        process.exit(1);
    });

async function loadAuthProvider(config) {
    let dir = await fs.readdirAsync(path.join(__dirname, '/provider/auth'));
    let authProvider;
    if (dir.length > 0) {
        let classes = [];
        for (let i = 0; i < dir.length; i++) {
            if (!dir[i].toLowerCase()
                    .startsWith('base')) {
                classes.push(require(path.join(__dirname, '/provider/auth', dir[i])));
            }
        }
        for (let i = 0; i < classes.length; i++) {
            if (classes[i].getId() === config.provider.auth.id) {
                authProvider = new classes[i](config.provider.auth);
            }
        }
    }
    return authProvider;
}

async function loadStorageProvider(config) {
    let dir = await fs.readdirAsync(path.join(__dirname, '/provider/storage'));
    let storageProvider;
    if (dir.length > 0) {
        let classes = [];
        for (let i = 0; i < dir.length; i++) {
            if (!dir[i].toLowerCase()
                    .startsWith('base')) {
                classes.push(require(path.join(__dirname, '/provider/storage', dir[i])));
            }
        }
        for (let i = 0; i < classes.length; i++) {
            if (classes[i].getId() === config.provider.storage.id) {
                storageProvider = new classes[i](config.provider.storage);
            }
        }
    }
    return storageProvider;
}