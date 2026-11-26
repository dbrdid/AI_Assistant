// Opt in only when building the local iPhone preview with a Personal Team.
module.exports = ({ config }) => {
  if (process.env.ATRIA_IOS_PREVIEW !== '1') return config;

  return {
    ...config,
    ios: {
      ...config.ios,
      bundleIdentifier: 'com.dbrdid.atria.iospreview',
      buildNumber: '1',
    },
    plugins: config.plugins.map(plugin => {
      const [name, options] = Array.isArray(plugin) ? plugin : [plugin];
      if (name === 'expo-notifications') {
        return [name, { ...options, enableRemoteNotifications: false }];
      }
      if (name === 'llama.rn') {
        return [name, { ...options, enableEntitlements: false }];
      }
      return plugin;
    }),
  };
};
