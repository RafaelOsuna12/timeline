# El SDK de PushFlow no usa reflexión; basta con conservar la API pública.
-keep class com.pushflow.sdk.PushFlow { public *; }
-keep class com.pushflow.sdk.PushFlowMessagingService { *; }
-keep class com.pushflow.sdk.NotificationActionReceiver { *; }
-keep class com.pushflow.sdk.NotificationOpenActivity { *; }
