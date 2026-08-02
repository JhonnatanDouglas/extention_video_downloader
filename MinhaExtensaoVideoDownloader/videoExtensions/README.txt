ORGANIZACAO DOS FORMATOS DE VIDEO

detect.js
- Identifica o formato pela extensao da URL, tipo de midia ou Content-Type.
- Retorna uma chave curta, como m3u8.

index.js
- Registra os handlers disponiveis.
- Resolve o handler diretamente por uma chave em Map.
- Somente o handler resolvido executa o processamento do download.

presentation.js
- Registra textos, prioridade e apresentacao de cada formato no popup.

nativeMediaHandler.js
- Compartilha o ciclo de jobs, progresso e comunicacao com o host nativo
  entre os formatos diretos e os que possuem faixas separadas.

m3u8/index.js
- Contem download, qualidade maxima, leitura de playlist, headers,
  progresso, repeticao e limpeza do formato m3u8.
- Envia a playlist VOD final ao host API 3, que baixa ate quatro segmentos
  em paralelo e usa o FFmpeg local para montar o MP4.
- Playlists ao vivo, de baixa latencia ou incompativeis usam o fluxo remoto
  tradicional do FFmpeg como fallback.

m3u8/presentation.js
- Contem nome do botao, recomendacao e prioridade visual do formato m3u8.

direct/index.js
- Baixa uma URL HTTP de video encontrada no player e remuxa para MP4.
- Tambem atende o redirecionamento oficial de video do TikTok.

tiktok/index.js
- Confere o item_id da URL com os dados do player do TikTok.
- Seleciona somente as variantes desse item e escolhe a maior resolucao.
- O background consulta novamente esses dados antes de iniciar o FFmpeg.

metaMp4/index.js
- Recebe as melhores faixas separadas de video e audio da Meta e pede
  ao FFmpeg para uni-las em um unico MP4.

metaMp4/detect.js
- Le os metadados EFG das URLs da Meta, agrupa pelo mesmo asset e remove
  os parametros que limitam a resposta a apenas um fragmento.

deepSearchMain.js
- Instrumenta os requests do Web Worker de video da Meta no contexto da
  pagina. Isso permite detectar o Facebook mesmo quando o video nao tem src.

PARA ADICIONAR OUTRO FORMATO

1. Crie uma pasta dentro de videoExtensions.
2. Exporte um handler com id, start, retry e cleanupTab.
3. Registre a extensao e o tipo de midia em detect.js.
4. Registre o handler em index.js.
5. Crie e registre a apresentacao usada pelo popup.

O Chrome nao suporta import() dinamico no service worker de extensoes.
Por isso os modulos sao importados estaticamente, mas o roteador usa Map
para localizar o formato sem executar sequencialmente os outros handlers.
