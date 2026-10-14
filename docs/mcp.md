# Analyse Xdebug par MCP

Le serveur local headless charge un fichier Xdebug une fois et expose les mêmes
arbres et coûts que l’interface. Le client MCP (Codex, par exemple) interroge ces
données et échange avec le modèle. Le serveur ne fait aucun appel à un modèle.

Node.js 20 ou plus est nécessaire. Après `npm install`, depuis le dépôt :

```sh
node --import tsx scripts/mcp-server.ts --profiles-dir ../sample
```

Ce processus communique en STDIO. Il ne lance aucun serveur réseau. Ses réponses
JSON-RPC occupent stdout ; les diagnostics doivent rester sur stderr. Pour le
connecter à Codex, utiliser directement Node, sans le préambule stdout de npm.

## Configuration Codex

Une configuration propre au projet peut être placée dans `.codex/config.toml`
du dossier de travail. Adapter les chemins absolus :

```toml
[mcp_servers.speedscope]
command = "/opt/homebrew/bin/node"
args = ["--import", "tsx", "/chemin/speedscope/scripts/mcp-server.ts", "--profiles-dir", "/chemin/sample"]
cwd = "/chemin/speedscope"
startup_timeout_sec = 20
tool_timeout_sec = 180
```

Codex charge cette configuration pour les projets de confiance. Recharger les
serveurs MCP ou ouvrir une nouvelle session après un changement de configuration.
Voir la [documentation officielle](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

Le serveur peut aussi être enregistré dans la configuration utilisateur de Codex,
sans changer la confiance du projet. Le chemin absolu du loader permet de lancer
le processus depuis n’importe quel dossier :

```sh
codex mcp add speedscope -- /opt/homebrew/bin/node --import /chemin/speedscope/node_modules/tsx/dist/loader.mjs /chemin/speedscope/scripts/mcp-server.ts --profiles-dir /chemin/sample
```

## Parcours d’analyse

1. `list_profiles` liste les fichiers du dossier autorisé.
2. `load_profile` charge un fichier et renvoie `datasetId` ainsi que les indices
   des métriques temps/mémoire. Un chargement remplace le jeu de données actif.
3. `find_functions` cherche par nom ou fichier et trie par coût total, propre ou
   nombre d’occurrences.
4. `function_callers` agrège les coûts de la fonction choisie selon ses appelants.
5. `function_invocations` récupère une page des occurrences les plus coûteuses.
6. `node_details` détaille une occurrence, sa pile et ses descendants ; `call_tree`
   permet de parcourir ses enfants.

Les requêtes d’analyse exigent le `datasetId` courant : un ancien chemin de nœud
est refusé après un rechargement. `profileIndex` vaut 0 par défaut. Les réponses
de listes sont paginées, avec 20 résultats par défaut et 100 au maximum ; l’offset
est limité à 1000 pour borner les recherches d’occurrences les plus coûteuses.
Utiliser une recherche ciblée ou descendre dans une branche pour affiner. Un chemin
est une liste d’indices d’enfants dans l’arbre original, indépendante du tri.

L’accès aux fichiers reste limité à `--profiles-dir`, y compris après résolution
des liens symboliques. Le serveur ne modifie aucun fichier. Les noms, chemins et
coûts retournés deviennent du contexte pour le modèle utilisé par le client.

## Sens des métriques

- **Total** comprend les sous-appels ; **Self** les exclut. Les totaux d’une pile
  ou de fonctions récursives se recouvrent : ne pas les additionner arbitrairement.
- **Occurrences** compte les enregistrements d’appels reconstruits.
- **Descendants** compte les nœuds sous une occurrence, en excluant celle-ci.
- **Call Order** expose des positions reconstruites à partir des coûts Xdebug.
  Le fichier ne contient pas les véritables horodatages ni la répartition du
  travail propre avant/entre les sous-appels.
- Les coûts mémoire sont cumulés selon les enregistrements ; ce n’est pas le pic
  mémoire PHP ni le pic RAM du navigateur ou du serveur de chargement.
- Le coût mesuré comprend les effets du profilage. Le fichier ne fournit pas
  les arguments SQL, le nom précis de chaque hook, ou des statistiques de cache.

## Vérification

```sh
./node_modules/.bin/jest --runInBand src/mcp/server.test.ts
node --import tsx scripts/mcp-smoke.ts
```

Le smoke test utilise le gros sample placé hors du dépôt dans `../sample/`.
Un autre nom de fichier peut être passé en argument. Il charge le profil via un
vrai client MCP, cherche une fonction et parcourt une occurrence. Les profils
restent hors Git. La connexion MCP et le navigateur possèdent chacun leur propre
profil en mémoire s’ils sont utilisés simultanément ; aucune copie intégrale ne
transite dans les réponses MCP.
