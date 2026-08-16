package com.it_nomads.fluttersecurestorage;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

import io.flutter.embedding.engine.plugins.FlutterPlugin;
import io.flutter.plugin.common.BinaryMessenger;
import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;
import io.flutter.plugin.common.MethodChannel.MethodCallHandler;
import io.flutter.plugin.common.MethodChannel.Result;

public class FlutterSecureStoragePlugin implements MethodCallHandler, FlutterPlugin {

    private static final String TAG = "FlutterSecureStoragePlugin";
    private MethodChannel channel;
    private Context applicationContext;
    private final Map<String, FlutterSecureStorage> storagesBySharedPreferencesName = new HashMap<>();
    private final Map<String, Integer> storageOperationCounts = new HashMap<>();
    private final Set<String> pendingStorageLocks = new HashSet<>();
    private HandlerThread workerThread;
    private Handler workerThreadHandler;

    public void initInstance(BinaryMessenger messenger, Context context) {
        try {
            applicationContext = context.getApplicationContext();

            workerThread = new HandlerThread("com.it_nomads.fluttersecurestorage.worker");
            workerThread.start();
            workerThreadHandler = new Handler(workerThread.getLooper());

            channel = new MethodChannel(messenger, "plugins.it_nomads.com/flutter_secure_storage");
            channel.setMethodCallHandler(this);
        } catch (Exception e) {
            Log.e(TAG, "Registration failed", e);
        }
    }

    @Override
    public void onAttachedToEngine(FlutterPluginBinding binding) {
        initInstance(binding.getBinaryMessenger(), binding.getApplicationContext());
    }

    @Override
    public void onDetachedFromEngine(@NonNull FlutterPluginBinding binding) {
        if (channel != null) {
            workerThread.quitSafely();
            workerThread = null;

            channel.setMethodCallHandler(null);
            channel = null;
        }
        synchronized (storagesBySharedPreferencesName) {
            for (FlutterSecureStorage storage : storagesBySharedPreferencesName.values()) {
                storage.lock();
            }
            storagesBySharedPreferencesName.clear();
            storageOperationCounts.clear();
            pendingStorageLocks.clear();
        }
        applicationContext = null;
    }

    @Override
    public void onMethodCall(@NonNull MethodCall call, @NonNull Result rawResult) {
        MethodResultWrapper result = new MethodResultWrapper(rawResult);
        // Run all method calls inside the worker thread instead of the platform thread.
        workerThreadHandler.post(new MethodRunner(call, result));
    }

    @SuppressWarnings("unchecked")
    private static String getKeyFromCall(FlutterSecureStorage storage, MethodCall call) {
        Map<String, Object> arguments = (Map<String, Object>) call.arguments;
        String key = (String) arguments.get("key");
        return storage.addPrefixToKey(key);
    }

    @SuppressWarnings("unchecked")
    private static String getValueFromCall(MethodCall call) {
        Map<String, Object> arguments = (Map<String, Object>) call.arguments;
        return (String) arguments.get("value");
    }

    private static String storageName(FlutterSecureStorageConfig config) {
        // Use "ns:" prefix for storageNamespace to avoid collisions with legacy
        // sharedPreferencesName keys in the map.
        return config.hasStorageNamespace()
                ? "ns:" + config.getStorageNamespace()
                : config.getSharedPreferencesName();
    }

    private FlutterSecureStorage getOrCreateStorage(FlutterSecureStorageConfig config) {
        final String name = storageName(config);
        synchronized (storagesBySharedPreferencesName) {
            FlutterSecureStorage existing = storagesBySharedPreferencesName.get(name);
            if (existing != null) {
                return existing;
            }
            FlutterSecureStorage created = new FlutterSecureStorage(applicationContext);
            storagesBySharedPreferencesName.put(name, created);
            return created;
        }
    }

    private void lockStorage(FlutterSecureStorageConfig config) {
        final String name = storageName(config);
        synchronized (storagesBySharedPreferencesName) {
            if (storageOperationCounts.getOrDefault(name, 0) > 0) {
                pendingStorageLocks.add(name);
                return;
            }
            lockStorageNow(name);
        }
    }

    private void lockStorageNow(String name) {
        FlutterSecureStorage storage = storagesBySharedPreferencesName.remove(name);
        if (storage != null) {
            storage.lock();
        }
    }

    private void beginStorageOperation(FlutterSecureStorageConfig config) {
        final String name = storageName(config);
        synchronized (storagesBySharedPreferencesName) {
            storageOperationCounts.put(name, storageOperationCounts.getOrDefault(name, 0) + 1);
        }
    }

    private void finishStorageOperation(FlutterSecureStorageConfig config) {
        final String name = storageName(config);
        synchronized (storagesBySharedPreferencesName) {
            int remaining = storageOperationCounts.getOrDefault(name, 0) - 1;
            if (remaining > 0) {
                storageOperationCounts.put(name, remaining);
                return;
            }
            storageOperationCounts.remove(name);
            if (pendingStorageLocks.remove(name)) {
                lockStorageNow(name);
            }
        }
    }

    private boolean storageOperationInFlight(FlutterSecureStorageConfig config) {
        synchronized (storagesBySharedPreferencesName) {
            return storageOperationCounts.getOrDefault(storageName(config), 0) > 0;
        }
    }

    private void ensureNoStorageOperationInFlight(FlutterSecureStorageConfig config) throws Exception {
        if (storageOperationInFlight(config)) {
            throw new Exception("Cannot delete secure storage while an operation is in progress.");
        }
    }

    private void releaseStorage(FlutterSecureStorageConfig config) {
        synchronized (storagesBySharedPreferencesName) {
            FlutterSecureStorage storage = storagesBySharedPreferencesName.remove(storageName(config));
            if (storage != null) {
                storage.lock();
            }
        }
    }

    private void deleteWithoutAuthentication(FlutterSecureStorageConfig config, String key) throws Exception {
        ensureNoStorageOperationInFlight(config);
        releaseStorage(config);
        String prefixedKey = config.getSharedPreferencesKeyPrefix() + "_" + key;
        boolean deleted = applicationContext
                .getSharedPreferences(config.getEffectiveDataPrefsName(), Context.MODE_PRIVATE)
                .edit()
                .remove(prefixedKey)
                .commit();
        if (!deleted) {
            throw new Exception("Failed to delete secure storage value.");
        }
    }

    /**
     * MethodChannel.Result wrapper that responds on the platform thread.
     */
    static class MethodResultWrapper implements Result {

        private final Result methodResult;
        private final Handler handler = new Handler(Looper.getMainLooper());
        private final AtomicBoolean submitted = new AtomicBoolean(false);

        MethodResultWrapper(Result methodResult) {
            this.methodResult = methodResult;
        }

        @Override
        public void success(final Object result) {
            if (!submitted.compareAndSet(false, true)) {
                Log.e(TAG, "Attempted to submit more than one result for a secure storage method call.");
                return;
            }
            handler.post(() -> methodResult.success(result));
        }

        @Override
        public void error(@NonNull final String errorCode, final String errorMessage, final Object errorDetails) {
            if (!submitted.compareAndSet(false, true)) {
                Log.e(TAG, "Attempted to submit more than one result for a secure storage method call.");
                return;
            }
            handler.post(() -> methodResult.error(errorCode, errorMessage, errorDetails));
        }

        @Override
        public void notImplemented() {
            if (!submitted.compareAndSet(false, true)) {
                Log.e(TAG, "Attempted to submit more than one result for a secure storage method call.");
                return;
            }
            handler.post(methodResult::notImplemented);
        }
    }

    /**
     * Wraps the functionality of onMethodCall() in a Runnable for execution in the worker thread.
     */
    class MethodRunner implements Runnable {
        private final MethodCall call;
        private final Result result;

        MethodRunner(MethodCall call, Result result) {
            this.call = call;
            this.result = result;
        }

        @SuppressWarnings("unchecked")
        @Override
        public void run() {
            // Guard MethodChannel payload before initialize(); funnel unexpected exceptions to result.error.
            try {
                if (call == null || call.arguments == null) {
                    handleException(new IllegalArgumentException("Method call arguments are null"));
                    return;
                }
                if (!(call.arguments instanceof Map)) {
                    handleException(new IllegalArgumentException("Method call arguments must be a Map"));
                    return;
                }
                Map<String, Object> args = (Map<String, Object>) call.arguments;
                Object rawOptions = args.get("options");
                Map<String, Object> options;
                if (rawOptions instanceof Map) {
                    options = (Map<String, Object>) rawOptions;
                } else {
                    options = new HashMap<>();
                }
                FlutterSecureStorageConfig config = new FlutterSecureStorageConfig(options);
                if ("lock".equals(call.method)) {
                    lockStorage(config);
                    result.success(null);
                    return;
                }
                if ("deleteWithoutAuthentication".equals(call.method)) {
                    String key = (String) args.get("key");
                    if (key == null) {
                        handleException(new IllegalArgumentException("Method call key is null"));
                        return;
                    }
                    deleteWithoutAuthentication(config, key);
                    result.success(null);
                    return;
                }
                FlutterSecureStorage secureStorage = getOrCreateStorage(config);
                beginStorageOperation(config);
                try {
                    secureStorage.initialize(config, new SecurePreferencesCallback<>() {
                @Override
                public void onSuccess(Void unused) {
                    try {
                        switch (call.method) {
                            case "write": {
                                String key = getKeyFromCall(secureStorage, call);
                                String value = getValueFromCall(call);

                                if (value != null) {
                                    secureStorage.write(key, value);
                                    result.success(null);
                                } else {
                                    result.error("null", null, null);
                                }
                                break;
                            }
                            case "read": {
                                String key = getKeyFromCall(secureStorage, call);

                                if (secureStorage.containsKey(key)) {
                                    String value = secureStorage.read(key);
                                    result.success(value);
                                } else {
                                    result.success(null);
                                }
                                break;
                            }
                            case "readAll": {
                                result.success(secureStorage.readAll());
                                break;
                            }
                            case "containsKey": {
                                String key = getKeyFromCall(secureStorage, call);

                                boolean containsKey = secureStorage.containsKey(key);
                                result.success(containsKey);
                                break;
                            }
                            case "delete": {
                                String key = getKeyFromCall(secureStorage, call);

                                secureStorage.delete(key);
                                result.success(null);
                                break;
                            }
                            case "deleteAll": {
                                secureStorage.deleteAll();
                                result.success(null);
                                break;
                            }
                            case "isBiometricAvailable": {
                                boolean available = secureStorage.isBiometricAvailable();
                                result.success(available);
                                break;
                            }
                            case "isDeviceSecure": {
                                boolean secure = secureStorage.isDeviceSecure();
                                result.success(secure);
                                break;
                            }
                            default:
                                result.notImplemented();
                                break;
                        }
                    } catch (Throwable e) {
                        if (e instanceof VirtualMachineError) {
                            throw (VirtualMachineError) e;
                        }
                        if (config.shouldDeleteOnFailure()) {
                            try {
                                secureStorage.deleteAll();
                                result.success("Data has been reset");
                            } catch (Throwable ex) {
                                handleException(ex);
                            }
                        } else {
                            handleException(e);
                        }
                    } finally {
                        finishStorageOperation(config);
                    }
                }

                @Override
                public void onError(Exception e) {
                    try {
                        handleException(e);
                    } finally {
                        finishStorageOperation(config);
                    }
                }
            });
                } catch (Throwable e) {
                    finishStorageOperation(config);
                    throw e;
                }
            } catch (Throwable e) {
                // Catch Throwable, not just Exception: some OEM builds throw
                // java.lang.Error subclasses (e.g. NoSuchFieldError) from Android
                // Keystore framework code, and an uncaught Error on this
                // HandlerThread would crash the entire app process. Genuine VM
                // errors (OOM, StackOverflow) are rethrown instead of being
                // funneled through handleException/deleteAll, which would
                // allocate memory the JVM may no longer have.
                if (e instanceof VirtualMachineError) {
                    throw (VirtualMachineError) e;
                }
                handleException(e);
            }
        }


        private void handleException(Throwable e) {
            StringWriter stringWriter = new StringWriter();
            e.printStackTrace(new PrintWriter(stringWriter));
            // Send exception message as the message field so Flutter can parse it
            String errorMessage = e.getMessage() != null ? e.getMessage() : "Unknown error";
            result.error("Exception encountered", errorMessage, stringWriter.toString());
        }
    }
}
