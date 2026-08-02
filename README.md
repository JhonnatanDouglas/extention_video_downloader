<div align="center">
  <img src="MinhaExtensaoVideoDownloader/icon-extension.png" width="96" alt="Ícone do DSL Video Downloader">

  # DSL Video Downloader

  **Download Sem Limites. Captura de mídia no navegador, processamento local e controle nas suas mãos.**

  `Chrome Extension` · `Native Messaging` · `FFmpeg` · `Windows`
</div>

---

## O projeto

O **DSL Video Downloader** é uma extensão pessoal para detectar e baixar a mídia ativa de uma página. O navegador encontra o conteúdo; um host nativo conversa com o FFmpeg instalado no Windows e entrega um MP4 pronto na pasta Downloads.

Sem anúncios, telemetria ou limites artificiais de quantidade e velocidade no código.

```text
Página → Extensão → Host nativo → FFmpeg → Downloads
```

## O que já funciona

- **HLS (`.m3u8`)**: seleciona a maior qualidade e baixa playlists VOD com quatro conexões paralelas.
- **Mídia direta**: remuxa URLs de vídeo e áudio para MP4 sem recodificação desnecessária.
- **Instagram e Facebook**: identifica faixas separadas e combina vídeo + áudio.
- **TikTok**: confirma o vídeo ativo para evitar baixar uma recomendação diferente.
- **Progresso no popup**: qualidade, bitrate, tempo, porcentagem, conclusão e erros.
- **Ações pós-download**: abre o vídeo ou revela o arquivo diretamente no Explorer.
- **Fallback seguro**: playlists HLS incompatíveis continuam pelo fluxo tradicional do FFmpeg.

## Instalação

Requisitos: **Windows 10/11**, **Google Chrome 122+** e **WinGet**.

1. Baixe ou compartilhe a pasta `MinhaExtensaoVideoDownloader`.
2. Abra `chrome://extensions` e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta da extensão.
4. Abra o popup e clique em **FFmpeg indisponível**.
5. Execute o instalador baixado e recarregue a extensão.

O instalador registra o host nativo para o ID fixo da extensão e instala o FFmpeg via WinGet quando necessário. O guia completo está em [`COMO-INSTALAR.txt`](MinhaExtensaoVideoDownloader/COMO-INSTALAR.txt).

## Estrutura

| Caminho | Responsabilidade |
|---|---|
| `MinhaExtensaoVideoDownloader/` | Extensão Chrome e instalador distribuível |
| `MinhaExtensaoVideoDownloader/videoExtensions/` | Detecção e fluxos específicos de cada formato |
| `native-host/` | Ponte local entre Chrome, Windows e FFmpeg |
| `setup-installer/` | Fonte do instalador do componente local |
| `build-native-components.ps1` | Compilação do host e do instalador |

Para recompilar os componentes nativos:

```powershell
.\build-native-components.ps1
```

## Pacotes

- `DSL-Video-Downloader-Extension.zip`: distribuição compactada.
- `DSL-Video-Downloader-Extension.crx`: pacote assinado da extensão.
- `DSL-Video-Downloader-Extension.pem`: chave que preserva o ID da extensão.

> Use somente em conteúdo próprio ou quando você tiver autorização para baixar. O projeto não remove DRM, criptografia proprietária ou controles de acesso.
