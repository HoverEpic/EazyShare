#! /bin/bash

if [ ! -d "config" ]; then
    echo "Creating config dir"
    mkdir config
fi

if [ ! -f "config/default.json" ]; then
    echo "Copying default config"
    cp sample_config/default.json config
fi

echo "Starting node"
npm start
