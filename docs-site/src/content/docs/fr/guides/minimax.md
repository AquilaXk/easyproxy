---
title: Clients MiniMax
description: Routez les commandes textuelles de MiniMax Code et MiniMax CLI par EasyProxy sans exposer les identifiants MiniMax.
---

MiniMax publie deux produits distincts en ligne de commande. EasyProxy intègre chacun à la frontière du protocole qu’il expose réellement :

- **MiniMax Code** (`mcode`) est un agent de programmation prenant en charge les fournisseurs Anthropic Messages personnalisés.
- **MiniMax CLI** (`mmx`) est un CLI de plateforme multimodale. Seule sa ressource `text` utilise l’API compatible avec Anthropic qu’EasyProxy peut router.

## MiniMax Code

Installez MiniMax Code et connectez-vous d’abord en suivant les instructions de MiniMax. Démarrez ensuite EasyProxy et activez l’intégration de fichier réversible :

```bash
epx start
```

Laissez le proxy fonctionner dans ce terminal. Dans un deuxième terminal, activez l’intégration et lancez MiniMax Code :

```bash
epx integration client enable --client mcode
epx mcode
```

![Intégration MiniMax Code avec des données d’exemple isolées](/screenshots/minimax-code-integration.png)

L’intégration fusionne un bloc dans `~/.minimax/config.yaml` :

```yaml
custom_provider:
  easyproxy:
    name: EasyProxy
    kind: custom
    enabled: true
    api: anthropic-messages
    options:
      apiKey: easyproxy-loopback
      baseURL: http://127.0.0.1:10100
      authMode: api-key
    models:
      anthropic/claude-opus-5:
        limit:
          context: 1000000
```

La liste de modèles générée, les fenêtres de contexte et les niveaux d’effort de raisonnement proviennent du catalogue EasyProxy actif. Les fenêtres peuvent inclure des [estimations pour les fournisseurs personnalisés](/fr/reference/configuration/providers/#contexte-des-fournisseurs-personnalisés) ; si le catalogue ne contient aucune fenêtre ou échelle d’effort, le champ correspondant est omis. MCode conserve l’effort actuellement sélectionné dans la session : EasyProxy exporte donc `effortOptions` sans remplacer cette sélection. Le bloc n’écrit aucune clé réelle, ne remplace pas `defaultModel` et ne modifie pas votre connexion MiniMax. Dans MCode, choisissez un modèle sous `custom_provider:easyproxy/...`.

`epx mcode` vérifie que ce fournisseur pointe vers le proxy actuellement actif avant de lancer le client. Après l’activation initiale, `epx sync` actualise le bloc géré lorsque le port ou les capacités du catalogue changent. La synchronisation automatique ne crée jamais un bloc non géré, ne recrée pas un bloc que vous avez supprimé et n’écrase pas un fichier modifié après l’écriture d’EasyProxy ; utilisez la commande d’activation lorsque vous souhaitez le reconnecter explicitement. Désactivez-le ou restaurez-le au moyen du même système d’intégration audité :

```bash
epx integration client disable --client mcode
epx integration client history --client mcode
epx integration client restore --op <opId> [--confirm-drift]
```

`MINIMAX_DATA_DIR` et l’ancienne variable `MAVIS_DATA_DIR` sont prises en charge. Les chemins relatifs sont refusés, car EasyProxy et MCode peuvent démarrer depuis des répertoires de travail différents.

## MiniMax CLI (`mmx`)

Installez séparément le CLI officiel :

```bash
npm install -g mmx-cli
mmx --version
```

Routez une commande textuelle par EasyProxy en utilisant l’enveloppe et un identifiant de modèle EasyProxy :

```bash
epx mmx text chat \
  --model anthropic/claude-opus-5 \
  --message "Explain this function"

epx mmx --output json text chat \
  --model openai/gpt-5.6-sol \
  --message "Return a JSON summary"
```

MMX ajoute systématiquement `/anthropic/v1/messages` à son URL de base d’API. L’enveloppe démarre un pont local temporaire pendant la durée du processus enfant. Celui-ci accepte uniquement les requêtes POST vers ce chemin Messages et vers `/anthropic/v1/messages/count_tokens`, puis les associe aux plans de données `/v1/messages` et `/v1/messages/count_tokens` existants d’EasyProxy tout en préservant le corps et les paramètres des requêtes. La traduction canonique des requêtes EasyProxy, le suivi de l’utilisation et l’authentification configurée des fournisseurs en aval restent actifs ; les fournisseurs reçoivent `x-api-key` ou un jeton porteur selon leur configuration. La diffusion conserve les événements Anthropic de message et de contenu. Avant le transfert, le pont retire les en-têtes d’identification d’admission entrants et fixe la valeur publique temporaire `easyproxy-loopback`. Aucune autre ressource Anthropic n’est transmise et le pont n’est jamais exposé au-delà de l’adresse locale.

L’enveloppe crée également un `MMX_CONFIG_DIR` temporaire qui ne contient que cette valeur publique, puis le supprime à la fermeture de `mmx`. Votre fichier `~/.mmx/config.json`, vos jetons OAuth et votre clé d’API MiniMax ne sont jamais chargés ni copiés.

Les limites suivantes sont intentionnelles :

- Seules les commandes `text chat` et `text repl` sont routées par EasyProxy.
- L’enveloppe refuse `--api-key`, `--base-url` et `--region` afin que les identifiants ou les destinations fournis par l’appelant n’entrent pas en conflit avec le pont isolé.
- Le pont est limité à l’adresse locale, car MMX ne peut pas envoyer l’en-tête d’admission dédié `x-easyproxy-api-key` d’EasyProxy pour une liaison distante.
- Utilisez directement `mmx` pour `image`, `video`, `speech`, `music`, `vision`, `search`, `quota`, `auth`, `config`, `file` et `update` ; ces ressources appellent des API propres à MiniMax qu’EasyProxy n’émule pas.

Le modèle textuel par défaut de `mmx` est `MiniMax-M3`. Fournissez `--model <provider/model>` pour cibler une route EasyProxy précise ; sinon, les règles normales de routage des modèles EasyProxy déterminent si l’identifiant par défaut est disponible.
