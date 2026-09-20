# Sowel Recipe — Accès invités au portail

Ouvre le portail quand un client du gîte ou de la lodge le demande depuis son téléphone. Les
demandes arrivent par le plugin
[`sowel-plugin-guest-access`](https://github.com/adn-dev-adrien/sowel-plugin-guest-access), qui tient
les accès, les codes et la page des clients ; cette recette est ce qui décide et actionne.

## Pourquoi une recette, et pas le plugin lui-même

Parce que **rien de ce qui décide ne doit aussi actionner**. Le plugin sert une page anonyme sur
Internet et détient les accès ; tout ce qu'il fait ici, c'est publier un compteur. L'équipement qui
s'ouvre, lui, est choisi par un administrateur, dans une instance de recette — si bien qu'une faille
du côté client ne peut pas se transformer toute seule en commande de portail.

Et elle vous laisse un interrupteur : la tuile du Dashboard arme ou coupe l'accès invités en un clic,
sans ouvrir la page des accès et sans attendre quoi que ce soit. Un accès coupé n'échoue pas en
silence — le téléphone du client affiche que la commande a été refusée depuis la maison.

## Ce qu'elle ne fait pas, volontairement

- **Elle ne regarde pas si le portail est ouvert avant de pulser.** Cette garde existait dans la
  première version, pour éviter qu'un deuxième client referme le portail sur la voiture du premier.
  Elle retirait quelque chose de légitime : refermer derrière soi. Décision d'Adrien du 2026-09-10 —
  la commande part toujours, comme la télécommande qu'elle remplace, avec la même propriété qu'un
  appui pendant la course inverse le mouvement.
- **Elle ne déduplique pas.** Le plugin absorbe déjà le double appui (fenêtre de 2 s), et c'est le
  seul endroit qui peut distinguer un doigt qui ripe de deux intentions.
- **Elle ne tient aucune échéance.** Rien ici ne referme le portail :
  [`portal-night-closure`](https://github.com/adn-dev-adrien/sowel-recipe-portal-night-closure) s'en
  charge, et deux automatisations tenant chacune sa propre échéance sur un portail à impulsion
  envoient deux impulsions pour une ouverture.

## Le contact du portail repart dans l'autre sens

Un plugin ne peut pas lire le device d'une autre intégration : c'est donc la recette qui lit l'état
du portail et le pousse au plugin, par un ordre. **Le client, lui, ne le voit jamais** — un bouton
qui dit « Fermer le portail » est un afficheur d'état déguisé en verbe, et la page des clients est
interrogeable par qui détient un code. C'est le propriétaire qui le voit, sur la page « Accès
invités » de Sowel.

L'état est lu **par catégorie** (`gate_state`, sinon `contact_door`), ce qui évite un champ d'alias
à remplir et survit à une installation nommée autrement.

## Réglages

| Champ | Défaut | Note |
| --- | --- | --- |
| Zone | — | La zone du portail |
| Demandes des invités | — | L'équipement lié au device du plugin `guest-access` |
| Alias du compteur | `requests` | La donnée qui compte les demandes |
| Portail | — | Type `gate` obligatoire |
| Alias de la commande | `command` | L'ordre du portail |
| Valeur de la commande | `pulse` | Une impulsion |

La validation refuse une configuration muette : sans les ordres `result` et `gate_state` sur
l'équipement des demandes, la recette pourrait ouvrir le portail sans jamais rien dire au client —
elle le signale à la création plutôt qu'à l'usage.

## Deux garde-fous

- **Le compteur ne déclenche jamais sur sa première lecture.** Au démarrage la donnée a déjà une
  valeur ; un redémarrage de recette ne doit pas ouvrir le portail.
- **Seule une valeur strictement supérieure** est une nouvelle demande. Une relecture identique,
  une valeur plus basse, une valeur non numérique : rien ne part.

## Installation

Source personnelle (spec 136) : **Plugins → Store → Sources personnelles** →
`adn-dev-adrien/sowel-recipe-guest-gate` → Installer → confirmer l'empreinte.

Elle se lie à l'équipement du plugin `guest-access` (device « Accès invités ») et au portail.

## Licence

AGPL-3.0
