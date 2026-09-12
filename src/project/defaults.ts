/** 工程级默认内容：新建工程时的示例源码。 */

export const DEFAULT_SKETCH = `// ESP32 GPIO 演示：LED 闪烁 + 按键控制
// 板载 LED 接 GPIO2，BOOT 按键接 GPIO0
#define LED_PIN 2
#define BOOT_PIN 0

int ledState = LOW;
unsigned long lastToggle = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(BOOT_PIN, INPUT_PULLUP);
  Serial.println("ESP32 仿真启动 OK");
}

void loop() {
  // 每 500ms 翻转 LED
  if (millis() - lastToggle >= 500) {
    ledState = !ledState;
    digitalWrite(LED_PIN, ledState);
    lastToggle = millis();
  }

  // 按键按下（低电平有效）时点亮 LED
  if (digitalRead(BOOT_PIN) == LOW) {
    digitalWrite(LED_PIN, HIGH);
  }
  delay(10);
}
`;
