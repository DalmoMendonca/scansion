export const BENCHMARK_CORPUS = [
  {
    id: 'sonnet18',
    title: 'Sonnet 18',
    author: 'William Shakespeare',
    profile: 'early_modern',
    meterFamily: 'iambic',
    formFamily: 'sonnet',
    ambiguityTypes: ['historical_profile', 'archaic_diction', 'sonnet_form'],
    sourceTruth: 'Canonical Shakespearean sonnet scansion and rhyme scheme.',
    poem: `Shall I compare thee to a summer's day?
Thou art more lovely and more temperate:
Rough winds do shake the darling buds of May,
And summer's lease hath all too short a date;
Sometime too hot the eye of heaven shines,
And often is his gold complexion dimm'd;
And every fair from fair sometime declines,
By chance or nature's changing course untrimm'd;
But thy eternal summer shall not fade,
Nor lose possession of that fair thou ow'st,
Nor shall death brag thou wander'st in his shade,
When in eternal lines to Time thou grow'st:
So long as men can breathe or eyes can see,
So long lives this, and this gives life to thee.`,
    expected: {
      overallMeter: 'iambic pentameter',
      form: 'shakespearean_sonnet',
      rhymeScheme: 'ABABCDCDEFEFGG',
      lineMeters: Array(14).fill('iambic_pentameter')
    }
  },
  {
    id: 'sonnet73',
    title: 'Sonnet 73',
    author: 'William Shakespeare',
    profile: 'early_modern',
    meterFamily: 'iambic',
    formFamily: 'sonnet',
    ambiguityTypes: ['historical_profile', 'archaic_diction', 'sonnet_form'],
    sourceTruth: 'Canonical Shakespearean sonnet scansion and rhyme scheme.',
    poem: `That time of year thou mayst in me behold
When yellow leaves, or none, or few, do hang
Upon those boughs which shake against the cold,
Bare ruin'd choirs, where late the sweet birds sang.
In me thou see'st the twilight of such day
As after sunset fadeth in the west,
Which by and by black night doth take away,
Death's second self, that seals up all in rest.
In me thou see'st the glowing of such fire
That on the ashes of his youth doth lie,
As the death-bed whereon it must expire,
Consum'd with that which it was nourish'd by.
This thou perceiv'st, which makes thy love more strong,
To love that well which thou must leave ere long.`,
    expected: {
      overallMeter: 'iambic pentameter',
      form: 'shakespearean_sonnet',
      rhymeScheme: 'ABABCDCDEFEFGG',
      lineMeters: Array(14).fill('iambic_pentameter')
    }
  },
  {
    id: 'dickinson-death',
    title: 'Because I could not stop for Death',
    author: 'Emily Dickinson',
    profile: 'modern',
    meterFamily: 'common_meter',
    formFamily: 'ballad',
    ambiguityTypes: ['common_meter', 'slant_rhyme', 'context_sensitive_stanza'],
    sourceTruth: 'Common-meter analysis with the inverted 6/8/8/6 fourth stanza.',
    poem: `Because I could not stop for Death -
He kindly stopped for me -
The Carriage held but just Ourselves -
And Immortality.

We slowly drove - He knew no haste
And I had put away
My labor and my leisure too,
For His Civility -

We passed the School, where Children strove
At Recess - in the Ring -
We passed the Fields of Gazing Grain -
We passed the Setting Sun -

Or rather - He passed Us -
The Dews drew quivering and Chill -
For only Gossamer, my Gown -
My Tippet - only Tulle -

We paused before a House that seemed
A Swelling of the Ground -
The Roof was scarcely visible -
The Cornice - in the Ground -

Since then - 'tis Centuries - and yet
Feels shorter than the Day
I first surmised the Horses' Heads
Were toward Eternity -`,
    expected: {
      overallMeter: 'common meter',
      form: 'common_meter_ballad',
      stanzaSchemePatterns: ['ABCB', 'ABCB', 'ABCD', 'ABCD', 'ABCB', 'ABCB'],
      lineMeters: [
        'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
        'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
        'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
        'iambic_trimeter', 'iambic_tetrameter', 'iambic_tetrameter', 'iambic_trimeter',
        'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter',
        'iambic_tetrameter', 'iambic_trimeter', 'iambic_tetrameter', 'iambic_trimeter'
      ]
    }
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    author: 'John Newton',
    profile: 'hymn',
    meterFamily: 'common_meter',
    formFamily: 'hymn',
    ambiguityTypes: ['common_meter', 'profile_sensitive', 'hymn_tuning'],
    sourceTruth: 'Standard hymn common meter with ABAB rhyme.',
    poem: `Amazing grace! How sweet the sound
That saved a wretch like me!
I once was lost, but now am found,
Was blind, but now I see.`,
    expected: {
      overallMeter: 'common meter',
      form: 'hymn_common_meter',
      rhymeScheme: 'ABAB',
      lineMeters: [
        'iambic_tetrameter',
        'iambic_trimeter',
        'iambic_tetrameter',
        'iambic_trimeter'
      ]
    }
  },
  {
    id: 'pope-criticism',
    title: 'Essay on Criticism (excerpt)',
    author: 'Alexander Pope',
    profile: 'early_modern',
    meterFamily: 'iambic',
    formFamily: 'couplets',
    ambiguityTypes: ['heroic_couplets', 'archaic_diction'],
    sourceTruth: 'A standard heroic-couplet pentameter excerpt.',
    poem: `True wit is nature to advantage dress'd,
What oft was thought, but ne'er so well express'd;
Something, whose truth convinc'd at sight we find,
That gives us back the image of our mind.`,
    expected: {
      overallMeter: 'iambic pentameter',
      form: 'heroic_couplets',
      rhymeScheme: 'AABB',
      lineMeters: [
        'iambic_pentameter',
        'iambic_pentameter',
        'iambic_pentameter',
        'iambic_pentameter'
      ]
    }
  }
];
