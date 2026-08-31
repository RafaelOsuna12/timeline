package com.honorlab.updater;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

/**
 * Recibe el resultado de la instalación.
 *
 * En un teléfono normal el sistema devuelve primero STATUS_PENDING_USER_ACTION:
 * hay que lanzar el diálogo de confirmación que Android incluye en el intent.
 * Solo una app propietaria del dispositivo (device owner) puede instalar en
 * silencio, y este actualizador no asume ese caso.
 */
public class UpdateInstallReceiver extends BroadcastReceiver {

    public static final String ACTION = "com.honorlab.updater.INSTALL_RESULT";
    private static final String TAG = "AppUpdater";

    /** Callback opcional para que la interfaz reaccione al resultado. */
    public interface ResultListener {
        void onInstallResult(boolean success, String message);
    }

    private static volatile ResultListener listener;

    public static void setResultListener(ResultListener value) {
        listener = value;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION.equals(intent.getAction())) {
            return;
        }
        int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS,
                PackageInstaller.STATUS_FAILURE);
        String message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);

        switch (status) {
            case PackageInstaller.STATUS_PENDING_USER_ACTION: {
                // El sistema pide confirmación al usuario: hay que mostrar su diálogo.
                Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    context.startActivity(confirm);
                } else {
                    Log.w(TAG, "El sistema pidió confirmación pero no adjuntó el intent");
                    notifyResult(false, "No se pudo mostrar la confirmación de instalación");
                }
                break;
            }
            case PackageInstaller.STATUS_SUCCESS:
                Log.i(TAG, "Actualización instalada");
                notifyResult(true, "Actualización instalada");
                break;

            default:
                Log.w(TAG, "Instalación fallida (status " + status + "): " + message);
                notifyResult(false, describe(status, message));
                break;
        }
    }

    private void notifyResult(boolean success, String message) {
        ResultListener current = listener;
        if (current != null) {
            current.onInstallResult(success, message);
        }
    }

    /** Traduce los códigos de PackageInstaller a algo que se pueda enseñar. */
    private static String describe(int status, String message) {
        switch (status) {
            case PackageInstaller.STATUS_FAILURE_ABORTED:
                return "El usuario canceló la instalación";
            case PackageInstaller.STATUS_FAILURE_BLOCKED:
                return "El sistema bloqueó la instalación";
            case PackageInstaller.STATUS_FAILURE_CONFLICT:
                // La causa casi siempre es firmar con un keystore distinto.
                return "Conflicto con la app instalada: ¿está firmada con el mismo keystore?";
            case PackageInstaller.STATUS_FAILURE_INCOMPATIBLE:
                return "El APK no es compatible con este dispositivo";
            case PackageInstaller.STATUS_FAILURE_INVALID:
                return "El APK está corrupto o mal firmado";
            case PackageInstaller.STATUS_FAILURE_STORAGE:
                return "No hay espacio suficiente para instalar";
            default:
                return message != null ? message : "Error de instalación (" + status + ")";
        }
    }
}
